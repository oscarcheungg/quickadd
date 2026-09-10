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
  const playlists = mine.map(p => ({ id: p.id, name: p.name, description: p.description || "", public: p.public === true, image: p.images?.at(-1)?.url || "", cover: p.images?.[0]?.url || "", ownerId: p.owner?.id, mine: p.owner?.id === lib.me.id, total: 0, lastAdded: 0, tracks: [] }));
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
  const entry = { id: p.id, name: p.name, description: "", public: false, image: "", cover: "", ownerId: lib.me?.id, mine: true, total: 0, lastAdded: Date.now(), tracks: [] };
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

// ---------- playlist details ----------
export async function updatePlaylistDetails(id, fields) {
  await api(`/playlists/${id}`, { method: "PUT", body: fields });
  const p = playlist(id); if (p) { Object.assign(p, fields); save(); }
}
// Cover must be a JPEG ≤ 256 KB, sent as raw base64. Needs the ugc-image-upload scope.
export async function uploadPlaylistCover(id, base64Jpeg, previewUrl) {
  const { accessToken } = await import("./spotify.js");
  const res = await fetch(`https://api.spotify.com/v1/playlists/${id}/images`, { method: "PUT", headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "image/jpeg" }, body: base64Jpeg });
  if (!res.ok) { const b = await res.json().catch(() => null); const e = new Error(b?.error?.message || `Upload failed (${res.status})`); e.status = res.status; throw e; }
  const p = playlist(id); if (p) { p.image = previewUrl; p.cover = previewUrl; save(); }
}
// Resize any picked image to a square JPEG under the limit.
export function imageToJpegBase64(file, size = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = size; c.height = size; const ctx = c.getContext("2d");
      const s = Math.min(img.width, img.height); ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      let q = 0.85, dataUrl = c.toDataURL("image/jpeg", q);
      while (dataUrl.length * 0.75 > 250_000 && q > 0.3) { q -= 0.1; dataUrl = c.toDataURL("image/jpeg", q); }
      URL.revokeObjectURL(url); resolve({ base64: dataUrl.split(",")[1], dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn’t read that image")); };
    img.src = url;
  });
}

// ---------- recommendations: playlist + listening history, no external model ----------
export async function topTracks(range = "short_term", limit = 50) {
  const r = await api(`/me/top/tracks?limit=${limit}&time_range=${range}`); return (r?.items || []).map(slimTrack);
}
const recCache = new Map();
export function recCacheClear() { recCache.clear(); }
// Signals: artists in the target (weight by count), recent plays, top tracks, library presence, catalog hits for the top target artists.
export async function recommend(targetId, { recents = [], top = [] } = {}, n = 12) {
  const t = playlist(targetId); if (!t) return [];
  const key = `${targetId}:${t.tracks.length}:${recents.length}:${top.length}`;
  if (recCache.has(key)) return recCache.get(key);
  const inT = new Set(t.tracks);
  const artistW = new Map();
  for (const uri of t.tracks) for (const a of track(uri)?.artists || []) artistW.set(a.id, { name: a.name, w: (artistW.get(a.id)?.w || 0) + 1 });
  const empty = artistW.size === 0;
  if (empty) for (const a of topArtists(6)) artistW.set(a.id, { name: a.name, w: 1 });
  const recentRank = new Map(recents.map((x, i) => [x.uri, i])); const topRank = new Map(top.map((x, i) => [x.uri, i]));
  const cand = new Map();
  const add = (tr, score, why) => { if (!tr?.uri || inT.has(tr.uri)) return; const c = cand.get(tr.uri) || { ...tr, score: 0, why: new Set() }; c.score += score; c.why.add(why); cand.set(tr.uri, c); };
  const artistScore = (tr) => tr.artists.reduce((m, a) => Math.max(m, artistW.get(a.id)?.w || 0), 0);
  // 1. your library, by artists in the playlist
  for (const tr of lib.tracks.values()) { const s = artistScore(tr); if (s) add(tr, s * 2 + Math.min(3, playlistsFor(tr.uri).length), "library"); }
  // 2. listening history
  recents.forEach((tr, i) => add(tr, 6 - i * 0.1 + artistScore(tr) * 2, "recent"));
  top.forEach((tr, i) => add(tr, 5 - i * 0.08 + artistScore(tr) * 2, "top"));
  // 3. catalog: popular songs by the playlist's main artists (or your top artists when empty)
  const mains = [...artistW.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, empty ? 4 : 3);
  const pages = await Promise.all(mains.map(([id, a]) => searchCatalog(`artist:${a.name}`, 0).then(r => r.filter(x => x.artists.some(y => y.id === id))).catch(() => [])));
  pages.forEach((list, pi) => list.forEach((tr, i) => add(tr, (mains[pi][1].w * 1.5) + (4 - i * 0.3), "catalog")));
  // rank, then keep artist variety: at most 3 per lead artist
  const perArtist = new Map(); const out = [];
  for (const c of [...cand.values()].sort((a, b) => b.score - a.score)) {
    const lead = c.artists[0]?.id; const k = perArtist.get(lead) || 0; if (k >= 3) continue; perArtist.set(lead, k + 1);
    out.push(c); if (out.length >= n) break;
  }
  recCache.set(key, out); return out;
}

// ---------- "add a list": resolve free text into tracks ----------
// Accepts lines or comma-separated entries like "title", "title - artist", "title by artist", "title (artist)".
export function parseSongList(text) {
  return text.split(/\n|,|;/).map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean).map(raw => {
    let m = raw.match(/^(.*?)\s+(?:-|–|—|by)\s+(.+)$/i); if (m) return { raw, title: m[1].trim(), artist: m[2].trim() };
    m = raw.match(/^(.*?)\s*\((.+)\)\s*$/); if (m) return { raw, title: m[1].trim(), artist: m[2].trim() };
    return { raw, title: raw, artist: "" };
  });
}
async function searchFew(q) { const r = await api(`/search?q=${encodeURIComponent(q)}&type=track&limit=5`); return (r?.tracks?.items || []).map(slimTrack); }
// Returns [{entry, candidates:[track...], pick: track|null}] — pick is the best guess.
export async function resolveSongList(entries, onOne) {
  const out = new Array(entries.length); let i = 0;
  async function worker() {
    while (i < entries.length) {
      const idx = i++; const e = entries[idx];
      let cands = [];
      try {
        if (e.artist) cands = await searchFew(`track:${e.title} artist:${e.artist}`);
        if (!cands.length) cands = await searchFew(e.artist ? `${e.title} ${e.artist}` : e.title);
      } catch {}
      out[idx] = { entry: e, candidates: cands, pick: cands[0] || null };
      onOne?.(idx, out[idx]);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
