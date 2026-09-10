// Library loader + index. Pulls every track from every playlist you own and
// builds lookups: track → playlists it lives in, artist → tracks.
import { api, apiAll } from "./spotify.js";

const CACHE_KEY = "qa.library.v2";
const MAX_AGE = 1000 * 60 * 60 * 12; // refresh after 12h, or on demand

export const lib = {
  me: null,
  playlists: [],          // [{id, name, image, ownerId, mine, total, lastAdded, tracks:[uri...]}]
  tracks: new Map(),      // uri → {uri,id,name,artists:[{id,name}],album,image,duration}
  inPlaylists: new Map(), // uri → Set(playlistId)
  artists: new Map(),     // artistId → {id,name,uris:Set}
  loadedAt: 0,
};

function slimTrack(t) {
  return { uri: t.uri, id: t.id, name: t.name, artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
    album: t.album?.name || "", image: t.album?.images?.at(-1)?.url || "", duration: t.duration_ms || 0 };
}

function rebuildIndex() {
  lib.inPlaylists = new Map(); lib.artists = new Map();
  for (const p of lib.playlists) {
    for (const uri of p.tracks) {
      if (!lib.inPlaylists.has(uri)) lib.inPlaylists.set(uri, new Set());
      lib.inPlaylists.get(uri).add(p.id);
      const t = lib.tracks.get(uri); if (!t) continue;
      for (const a of t.artists) {
        if (!lib.artists.has(a.id)) lib.artists.set(a.id, { id: a.id, name: a.name, uris: new Set() });
        lib.artists.get(a.id).uris.add(uri);
      }
    }
  }
}

function save() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ loadedAt: lib.loadedAt, me: lib.me, playlists: lib.playlists, tracks: [...lib.tracks.values()] }));
  } catch (e) { console.warn("cache too large, skipping", e); }
}

export function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!c) return false;
    lib.me = c.me; lib.playlists = c.playlists; lib.loadedAt = c.loadedAt;
    lib.tracks = new Map(c.tracks.map(t => [t.uri, t]));
    rebuildIndex();
    return true;
  } catch { return false; }
}

export function isStale() { return Date.now() - lib.loadedAt > MAX_AGE; }

// onProgress({done, total, label})
export async function loadLibrary(onProgress) {
  lib.me = await api("/me");
  const raw = await apiAll("/me/playlists?limit=50");
  const mine = raw.filter(p => p.owner?.id === lib.me.id || p.collaborative);
  const playlists = mine.map(p => ({ id: p.id, name: p.name, image: p.images?.at(-1)?.url || "", ownerId: p.owner?.id, mine: p.owner?.id === lib.me.id, total: 0, lastAdded: 0, tracks: [] }));
  lib.tracks = new Map();
  let done = 0;
  const queue = [...playlists];
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const items = await apiAll(`/playlists/${p.id}/items?limit=100&fields=next,total,items(added_at,item(uri,id,name,type,duration_ms,artists(id,name),album(name,images)))`);
      for (const it of items) {
        const t = it.item; if (!t || t.type !== "track" || !t.uri) continue;
        if (!lib.tracks.has(t.uri)) lib.tracks.set(t.uri, slimTrack(t));
        p.tracks.push(t.uri);
        const ts = Date.parse(it.added_at || 0) || 0; if (ts > p.lastAdded) p.lastAdded = ts;
      }
      p.total = p.tracks.length;
      done++; onProgress?.({ done, total: playlists.length, label: p.name });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  playlists.sort((a, b) => b.lastAdded - a.lastAdded);
  lib.playlists = playlists; lib.loadedAt = Date.now();
  rebuildIndex(); save();
}

// After publishing: reflect new tracks in the index without a full reload.
export function addToPlaylistLocal(playlistId, tracks) {
  const p = lib.playlists.find(p => p.id === playlistId); if (!p) return;
  for (const t of tracks) { if (!lib.tracks.has(t.uri)) lib.tracks.set(t.uri, slimTrack(t.raw || t)); p.tracks.push(t.uri); }
  p.total = p.tracks.length; p.lastAdded = Date.now();
  lib.playlists.sort((a, b) => b.lastAdded - a.lastAdded);
  rebuildIndex(); save();
}
export function removeFromPlaylistLocal(playlistId, uris) {
  const p = lib.playlists.find(p => p.id === playlistId); if (!p) return;
  const set = new Set(uris); p.tracks = p.tracks.filter(u => !set.has(u)); p.total = p.tracks.length;
  rebuildIndex(); save();
}

export const playlist = (id) => lib.playlists.find(p => p.id === id);
export const track = (uri) => lib.tracks.get(uri);
export const playlistsFor = (uri) => [...(lib.inPlaylists.get(uri) || [])].map(playlist).filter(Boolean);
export const inPlaylist = (uri, playlistId) => lib.inPlaylists.get(uri)?.has(playlistId) || false;

export function topArtists(n = 8) {
  return [...lib.artists.values()].sort((a, b) => b.uris.size - a.uris.size).slice(0, n);
}
export function artistTracks(artistId) {
  const a = lib.artists.get(artistId); if (!a) return [];
  return [...a.uris].map(track).filter(Boolean).sort((x, y) => (lib.inPlaylists.get(y.uri)?.size || 0) - (lib.inPlaylists.get(x.uri)?.size || 0) || x.name.localeCompare(y.name));
}
export function playlistArtists(playlistId, n = 6) {
  const p = playlist(playlistId); const count = new Map();
  for (const uri of p?.tracks || []) for (const a of track(uri)?.artists || []) count.set(a.id, { ...a, n: (count.get(a.id)?.n || 0) + 1 });
  return [...count.values()].sort((a, b) => b.n - a.n).slice(0, n);
}

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export function searchLibrary(q) {
  const n = norm(q.trim()); if (!n) return [];
  const words = n.split(/\s+/);
  const hits = [];
  for (const t of lib.tracks.values()) {
    const hay = norm(t.name + " " + t.artists.map(a => a.name).join(" ") + " " + t.album);
    if (words.every(w => hay.includes(w))) hits.push(t);
  }
  return hits.sort((a, b) => (norm(a.name).startsWith(n) ? -1 : 0) - (norm(b.name).startsWith(n) ? -1 : 0) || a.name.localeCompare(b.name)).slice(0, 40);
}
export function searchPlaylists(q) {
  const n = norm(q.trim()); if (!n) return [];
  return lib.playlists.filter(p => norm(p.name).includes(n)).slice(0, 5);
}

// Live data (not cached)
export async function nowPlaying() { const r = await api("/me/player/currently-playing"); return r?.item?.type === "track" ? { track: slimTrack(r.item), raw: r.item, playing: r.is_playing } : null; }
export async function recentlyPlayed() {
  const r = await api("/me/player/recently-played?limit=50"); const seen = new Set(); const out = [];
  for (const it of r?.items || []) { if (!it.track?.uri || seen.has(it.track.uri)) continue; seen.add(it.track.uri); out.push({ ...slimTrack(it.track), playedAt: it.played_at }); }
  return out;
}
// NOTE: Spotify caps search at limit=10 per call for this app (11+ → 400 "Invalid limit"),
// and combined type=track,artist calls are flaky. So: separate calls, page with offset.
export async function searchCatalog(q, offset = 0) {
  const r = await api(`/search?q=${encodeURIComponent(q)}&type=track&limit=10&offset=${offset}`);
  return (r?.tracks?.items || []).map(slimTrack);
}
export async function searchArtists(q) {
  const r = await api(`/search?q=${encodeURIComponent(q)}&type=artist&limit=6`);
  return (r?.artists?.items || []).map(a => ({ id: a.id, name: a.name, image: a.images?.at(-1)?.url || "", followers: a.followers?.total || 0 }));
}
// Songs + artists from the whole Spotify catalog, first page.
export async function searchAll(q) {
  const [tracks, artists] = await Promise.all([searchCatalog(q, 0), searchArtists(q).catch(() => [])]);
  return { tracks, artists };
}
// /artists/{id}/top-tracks is 403 for this app, so use an artist-filtered song search (2 pages).
export async function artistTopTracks(id, name) {
  const q = `artist:${name}`;
  const [a, b] = await Promise.all([searchCatalog(q, 0), searchCatalog(q, 10).catch(() => [])]);
  const seen = new Set();
  return [...a, ...b].filter(t => t.artists.some(x => x.id === id) && !seen.has(t.uri) && seen.add(t.uri));
}

// ---------- recommendations from your own library ----------
// Songs in your other playlists, by artists already in the target (or your top artists if it's empty).
export function libraryRecs(targetId, n = 12) {
  const t = playlist(targetId); if (!t) return [];
  const inT = new Set(t.tracks);
  const artistCount = new Map();
  for (const uri of t.tracks) for (const a of track(uri)?.artists || []) artistCount.set(a.id, { name: a.name, n: (artistCount.get(a.id)?.n || 0) + 1 });
  const seedArtists = artistCount.size ? artistCount : new Map(topArtists(8).map(a => [a.id, { name: a.name, n: 1 }]));
  const scored = [];
  for (const tr of lib.tracks.values()) {
    if (inT.has(tr.uri)) continue;
    const hit = tr.artists.find(a => seedArtists.has(a.id)); if (!hit) continue;
    const seed = seedArtists.get(hit.id); const lists = playlistsFor(tr.uri).filter(p => p.id !== targetId);
    if (!lists.length) continue;
    const score = seed.n * 2 + lists.length;
    const reason = artistCount.size ? `${seed.n} ${seed.name} song${seed.n > 1 ? "s" : ""} already here · in ${lists.slice(0, 2).map(p => p.name).join(", ")}` : `You save ${seed.name} a lot · in ${lists.slice(0, 2).map(p => p.name).join(", ")}`;
    scored.push({ ...tr, score, reason });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, n);
}

export async function createPlaylist(name) {
  const p = await api("/me/playlists", { method: "POST", body: { name, public: false, description: "Built with Playlist Mode" } });
  const entry = { id: p.id, name: p.name, image: "", ownerId: lib.me?.id, mine: true, total: 0, lastAdded: Date.now(), tracks: [] };
  lib.playlists.unshift(entry); save();
  return entry;
}

// ---------- artist photos ----------
// /artists?ids= (batch) is 403 for this app; /artists/{id} works. Fetch one at a time, lazily, and cache.
const IMG_KEY = "qa.artistImg.v1";
let imgCache = null; const imgPending = new Map();
function loadImgCache() { if (!imgCache) { try { imgCache = JSON.parse(localStorage.getItem(IMG_KEY)) || {}; } catch { imgCache = {}; } } return imgCache; }
export function artistImageCached(id) { return loadImgCache()[id] ?? null; }
export function artistImage(id) {
  const c = loadImgCache(); if (id in c) return Promise.resolve(c[id]);
  if (imgPending.has(id)) return imgPending.get(id);
  const p = api(`/artists/${id}`).then(a => { const url = a?.images?.at(-1)?.url || ""; c[id] = url; try { localStorage.setItem(IMG_KEY, JSON.stringify(c)); } catch {} return url; })
    .catch(() => "").finally(() => imgPending.delete(id));
  imgPending.set(id, p); return p;
}
