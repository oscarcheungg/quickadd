import { login, logout, handleCallback, getStoredToken, api } from "./spotify.js";
import * as D from "./data.js";
import * as AI from "./ai.js";
const { lib } = D;

// ---------- state ----------
const S = {
  screen: { name: "home" }, stack: [],
  target: sessionStorage.getItem("qa.target") || null,   // chosen per session, never assumed
  selection: JSON.parse(sessionStorage.getItem("qa.sel") || "[]"), // [{uri, source, track}]
  keep: new Set(),
  nowPlaying: null, recents: [], catalog: { tracks: [], artists: [] }, catalogQ: "",
  ai: { status: "idle", items: [], error: "", forTarget: null, dismissed: new Set() }, // idle | loading | ready | error | nokey
  lastPublish: null, sheet: null, dragFrom: null,
};
const $app = document.getElementById("app");
const $toast = document.getElementById("toast");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} min`; };
const artists = (t) => t.artists.map(a => a.name).join(", ");
const initials = (n) => n.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const ago = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60000; return m < 60 ? `${Math.max(1, Math.round(m))} m ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const persistSel = () => sessionStorage.setItem("qa.sel", JSON.stringify(S.selection));
const matches = (t, q) => { const n = q.toLowerCase(); return (t.name + " " + artists(t)).toLowerCase().includes(n); };

// ---------- selection ----------
const target = () => D.playlist(S.target);
const isSelected = (uri) => S.selection.some(s => s.uri === uri);
const inTarget = (uri) => D.inPlaylist(uri, S.target);
function select(track, source) { if (isSelected(track.uri)) return; S.selection.push({ uri: track.uri, source, track }); persistSel(); render(); }
function deselect(uri) { S.selection = S.selection.filter(s => s.uri !== uri); persistSel(); render(); }
function toggle(track, source) { isSelected(track.uri) ? deselect(track.uri) : select(track, source); }
const newCount = () => S.selection.filter(s => !inTarget(s.uri) || S.keep.has(s.uri)).length;
function setTarget(id) { S.target = id; sessionStorage.setItem("qa.target", id); S.keep = new Set(); S.ai = { status: "idle", items: [], error: "", forTarget: null, dismissed: new Set() }; }

// ---------- navigation ----------
function go(screen) { S.stack.push(S.screen); S.screen = screen; render(); $app.querySelector(".body")?.scrollTo(0, 0); }
function back() { S.screen = S.stack.pop() || { name: "home" }; render(); }
function home() { S.stack = []; S.screen = { name: "home" }; render(); loadSuggestions(); }

// ---------- toast ----------
let toastTimer;
function toast(msg, action, fn, ms = 6000) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="ink" data-toast-action>${esc(action)}</button>` : ""}`;
  $toast.hidden = false;
  $toast.querySelector("[data-toast-action]")?.addEventListener("click", () => { $toast.hidden = true; fn?.(); });
  toastTimer = setTimeout(() => { $toast.hidden = true; }, ms);
}

// ---------- shared pieces ----------
function rowHTML(t, { mode = "plus", sub, trail, extra = "", cls = "" } = {}) {
  const inT = inTarget(t.uri), sel = isSelected(t.uri);
  const subText = sub ?? artists(t);
  let ctrl = "";
  if (mode === "plus") ctrl = inT ? `<span class="plus done" title="Already in ${esc(target()?.name)}">✓</span>` : sel ? `<button class="plus pending" data-deselect="${esc(t.uri)}" title="Added — tap to undo">✓</button>` : `<button class="plus" data-select="${esc(t.uri)}" aria-label="Add">+</button>`;
  else if (mode === "check") ctrl = inT ? `<span class="check on disabled">✓</span>` : `<span class="check ${sel ? "on" : ""}">${sel ? "✓" : ""}</span>`;
  else if (mode === "review") ctrl = `<button class="x" data-remove="${esc(t.uri)}">✕</button>`;
  const trailHTML = trail ? `<span class="trail ${trail.cls || ""}">${esc(trail.text)}</span>` : (inT && mode !== "review" && mode !== "plain" ? `<span class="trail green">in ${esc(target()?.name)}</span>` : "");
  return `<div class="row ${sel && mode === "check" ? "selected" : ""} ${mode === "check" && !inT ? "tappable" : ""} ${cls}" data-uri="${esc(t.uri)}" ${mode === "check" && !inT ? `data-toggle="${esc(t.uri)}"` : ""}>
    ${mode === "review" ? `<span class="handle" data-handle>≡</span>` : ""}${mode === "check" ? ctrl : ""}
    ${t.image ? `<img class="art" src="${esc(t.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title ${inT ? "in-target" : ""}">${esc(t.name)}</div><div class="sub">${esc(subText)}</div></div>
    ${trailHTML}${extra}${mode !== "check" ? ctrl : ""}
  </div>`;
}
const section = (label, action) => `<div class="section"><span>${esc(label)}</span><span class="spacer"></span>${action ? `<button data-action="${esc(action.id)}">${esc(action.label)}</button>` : ""}</div>`;
const playlistRowHTML = (p, attr = "data-open-playlist") => `<div class="row tappable" ${attr}="${esc(p.id)}">${p.image ? `<img class="art" src="${esc(p.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title ${p.id === S.target ? "in-target" : ""}">${esc(p.name)}</div><div class="sub">${p.total} song${p.total === 1 ? "" : "s"}${p.lastAdded ? ` · edited ${ago(new Date(p.lastAdded).toISOString())}` : ""}</div></div><span class="chev">›</span></div>`;
const artistCardHTML = (a) => `<button class="artist" data-open-artist="${esc(a.id)}"><div class="avatar">${esc(initials(a.name))}</div><div class="name">${esc(a.name)}</div><div class="count">${a.uris.size} saved</div></button>`;
const bannerHTML = () => { const p = target(); return p ? `<div class="mode-banner"><span class="label">Adding to</span><span class="name">${esc(p.name)}</span><span class="spacer"></span><span class="count">${p.total + newCount()} song${p.total + newCount() === 1 ? "" : "s"}</span></div>` : ""; };
const headHTML = (title, withBack, right = "") => withBack
  ? `<div class="head stacked"><button class="back" data-back aria-label="Back">‹</button><h1>${esc(title)}</h1></div>`
  : `<div class="head"><h1>${esc(title)}</h1>${right}</div>`;
function segHTML() {
  const n = S.selection.length, t = target(), isReview = S.screen.name === "review";
  return `<div class="seg"><button class="${!isReview ? "on" : ""}" data-action="find">Find${n ? ` · ${n} selected` : ""}</button><button class="${isReview ? "on target" : ""}" data-action="review">${esc(t?.name || "Playlist")}${t ? ` · ${t.total}` : ""}</button></div>`;
}
function ctaHTML() {
  const n = S.selection.length, t = target();
  if (S.screen.name === "review") { const k = newCount(); return `<div class="cta">${n ? `<button class="btn ghost" data-action="discard">Discard ${n}</button>` : ""}<button class="btn green" data-action="publish" ${k ? "" : "disabled"}>${k ? `Publish ${k} to Spotify` : "Nothing new to publish"}</button></div>`; }
  return `<div class="cta"><button class="btn" data-action="review" ${n ? "" : "disabled"}>${n ? `Review ${n} in ${esc(t?.name)} →` : `Tap + on songs to add to ${esc(t?.name)}`}</button></div>`;
}
const searchFieldHTML = (q) => `<div class="field search"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><input id="q" type="search" placeholder="What's on your mind?" value="${esc(q)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">${q ? `<button class="clear" data-action="clearq">✕</button>` : ""}</div>`;

// ---------- entry: choose what to build ----------
function startHTML() {
  const name = (lib.me?.display_name || "").split(" ")[0];
  return `<div class="splash start"><p class="eyebrow">Playlist Mode</p><h1>Hello, ${esc(name || "there")}!</h1><p>What are you creating today?</p>
    <div class="start-actions">
      <button class="btn green" data-action="start-new">＋ New playlist</button>
      <button class="btn" data-action="start-existing">Add to an existing playlist</button>
    </div>
  </div>`;
}
function newHTML() {
  return `<div class="body centered"><h1>New playlist</h1><div class="field"><input id="pname" placeholder="Playlist name" autocomplete="off" enterkeyhint="done" value="${esc(S.screen.value || "")}"></div></div>
    <div class="cta"><button class="btn green" data-action="create" ${(S.screen.value || "").trim() ? "" : "disabled"}>Create and start adding</button></div>`;
}
function existingHTML() { return `<div class="body" style="padding-top:6px">${lib.playlists.filter(p => p.mine).map(p => playlistRowHTML(p, "data-set-target")).join("")}</div>`; }

// ---------- home: suggestions ----------
function homeHTML() {
  return `${searchFieldHTML("")}
    <div class="tiles">
      <button class="tile" data-action="playlists"><span class="tile-icon">☰</span><span class="tile-name">Your playlists</span><span class="tile-sub">${lib.playlists.length}</span></button>
      <button class="tile" data-action="recents"><span class="tile-icon">↺</span><span class="tile-name">Recently played</span><span class="tile-sub">${S.recents.length || "…"}</span></button>
      <button class="tile" data-action="artists"><span class="tile-icon">♪</span><span class="tile-name">Your artists</span><span class="tile-sub">${lib.artists.size}</span></button>
    </div>
    ${librarySectionHTML()}`;
}
function aiSectionHTML() {
  const a = S.ai, p = target();
  const head = section(`Suggested for ${p.name}`, a.status === "ready" ? { id: "ai-refresh", label: "More" } : null);
  if (!AI.getKey()) return `${head}<div class="banner"><span>Add a Claude API key to get suggestions picked for this playlist.</span><span class="spacer"></span><button data-action="settings">Add key</button></div>`;
  if (a.status === "loading") return `${head}<div class="empty">Claude is listening to ${esc(p.name)}…</div>`;
  if (a.status === "error") return `${head}<div class="banner"><span>${esc(a.error)}</span><span class="spacer"></span><button data-action="ai-refresh">Retry</button></div>`;
  const items = a.items.filter(t => !a.dismissed.has(t.uri));
  if (a.status === "ready" && !items.length) return `${head}<div class="empty">No more suggestions. Tap More for another set.</div>`;
  return head + items.map(t => rowHTML(t, { sub: t.reason, extra: `<button class="x" data-dismiss="${esc(t.uri)}" title="Not this one">✕</button>` })).join("");
}
function librarySectionHTML() {
  const recs = D.libraryRecs(S.target, 8);
  if (!recs.length) return "";
  return section("From your other playlists") + recs.map(t => rowHTML(t, { sub: artists(t) })).join("");
}
function npCardHTML(np) {
  const t = np.track, inT = inTarget(t.uri), sel = isSelected(t.uri);
  return `${section(np.playing ? "Now playing" : "Paused")}<div class="card">${t.image ? `<img class="art" src="${esc(t.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title">${esc(t.name)}</div><div class="sub">${esc(artists(t))}</div></div>
    ${inT ? `<span class="pill done">✓ in ${esc(target()?.name)}</span>` : sel ? `<button class="pill" data-deselect="${esc(t.uri)}">✓ Added</button>` : `<button class="pill" data-select="${esc(t.uri)}">+ Add</button>`}</div>`;
}
async function loadSuggestions(force = false) {
  const p = target(); if (!p || !AI.getKey()) return;
  if (!force && S.ai.forTarget === p.id && S.ai.status === "ready") return;
  S.ai.status = "loading"; S.ai.forTarget = p.id; render();
  try {
    const ctx = { name: p.name, tracks: p.tracks.map(D.track).filter(Boolean), topArtists: D.topArtists(15).map(a => a.name) };
    const items = (await AI.suggest(ctx, 10)).filter(t => !inTarget(t.uri) && !S.ai.dismissed.has(t.uri));
    if (S.target !== p.id) return;
    S.ai.items = items; S.ai.status = "ready";
  } catch (e) { S.ai.status = "error"; S.ai.error = e?.status === 401 ? "That API key was rejected." : (e.message || "Couldn’t get suggestions"); }
  if (S.screen.name === "home") render();
}

// ---------- browse screens ----------
function searchHTML() {
  const q = S.screen.q || "";
  const ready = S.catalogQ === q; const res = ready ? S.catalog : { tracks: [], artists: [] };
  const selectable = res.tracks.filter(t => !inTarget(t.uri) && !isSelected(t.uri));
  return `${searchFieldHTML(q)}
    ${res.artists.length ? section("Artists") + `<div class="hscroll">${res.artists.map(a => `<button class="artist" data-open-catalog-artist="${esc(a.id)}"><div class="avatar">${a.image ? `<img src="${esc(a.image)}" alt="">` : esc(initials(a.name))}</div><div class="name">${esc(a.name)}</div></button>`).join("")}</div>` : ""}
    ${section(res.tracks.length ? `Songs · ${res.tracks.length}` : "Songs", selectable.length > 1 ? { id: "selectall", label: `Select all ${selectable.length}` } : null)}
    <div id="catalog">${res.tracks.length ? res.tracks.map(t => rowHTML(t, { sub: artists(t) })).join("") : ready ? `<div class="empty">No results on Spotify for “${esc(q)}”.</div>` : `<div class="empty">Searching Spotify…</div>`}</div>
    ${ready && res.tracks.length >= 10 && !res.done ? `<div class="more"><button class="chip" data-action="more-results">${res.loading ? "Loading…" : "More results"}</button></div>` : ""}`;
}
function catalogArtistHTML() {
  const a = S.screen.artist; const tracks = S.screen.tracks || null;
  const selectable = (tracks || []).filter(t => !inTarget(t.uri) && !isSelected(t.uri));
  return `<div class="thead">${a.image ? `<img class="art" style="border-radius:50%" src="${esc(a.image)}" alt="">` : `<div class="art"></div>`}<div class="meta"><div class="title">${esc(a.name)}</div><div class="sub">Popular on Spotify</div></div></div>
    ${section("Top songs", selectable.length > 1 ? { id: "selectall", label: `Select all ${selectable.length}` } : null)}
    ${tracks ? (tracks.length ? tracks.map(t => rowHTML(t, { sub: t.album })).join("") : `<div class="empty">No songs found.</div>`) : `<div class="empty">Loading…</div>`}`;
}
function playlistHTML() {
  const p = D.playlist(S.screen.id); if (!p) return `<div class="empty">Playlist not found.</div>`;
  const chips = D.playlistArtists(p.id, 8), active = S.screen.artist || null, filter = (S.screen.filter || "").toLowerCase();
  let tracks = p.tracks.map(D.track).filter(Boolean);
  if (active) tracks = tracks.filter(t => t.artists.some(a => a.id === active));
  if (filter) tracks = tracks.filter(t => matches(t, filter));
  const selectable = tracks.filter(t => !inTarget(t.uri) && !isSelected(t.uri));
  return `<div class="field"><span class="muted">⌕</span><input id="pf" type="search" placeholder="Filter in ${esc(p.name)}" value="${esc(S.screen.filter || "")}" autocomplete="off"></div>
    <div class="chips"><button class="chip ${!active ? "on" : ""}" data-chip="">All ${p.total}</button>${chips.map(a => `<button class="chip ${active === a.id ? "on" : ""}" data-chip="${esc(a.id)}">${esc(a.name)} · ${a.n}</button>`).join("")}</div>
    ${section(`${tracks.length} songs`, selectable.length > 1 ? { id: "selectall", label: `Select all ${selectable.length}` } : null)}
    ${tracks.map(t => rowHTML(t, { mode: "check", sub: artists(t) })).join("")}`;
}
function artistHTML() {
  const a = lib.artists.get(S.screen.id); if (!a) return `<div class="empty">Artist not found.</div>`;
  const tracks = D.artistTracks(a.id), lists = new Set(tracks.flatMap(t => D.playlistsFor(t.uri).map(p => p.id)));
  const selectable = tracks.filter(t => !inTarget(t.uri) && !isSelected(t.uri));
  return `${section(`${tracks.length} songs across ${lists.size} playlists`, selectable.length > 1 ? { id: "selectall", label: `Select all ${selectable.length}` } : null)}
    ${tracks.map(t => rowHTML(t, { mode: "check", sub: D.playlistsFor(t.uri).map(p => p.name).join(", ") })).join("")}`;
}
const artistsHTML = () => `${section("By songs saved")}${D.topArtists(200).map(a => `<div class="row tappable" data-open-artist="${esc(a.id)}"><div class="art round" style="display:grid;place-items:center;font-weight:700;color:var(--muted)">${esc(initials(a.name))}</div><div class="meta"><div class="title">${esc(a.name)}</div><div class="sub">${a.uris.size} saved</div></div><span class="chev">›</span></div>`).join("")}`;
const playlistsHTML = () => `${section("Last edited first")}${lib.playlists.map(p => playlistRowHTML(p)).join("")}`;
const recentsHTML = () => S.recents.length ? `${section("Last 50 plays")}${S.recents.map(t => rowHTML(t, { sub: `${artists(t)} · ${ago(t.playedAt)}` })).join("")}` : `<div class="empty">Nothing played recently.</div>`;

// ---------- review ----------
function reviewHTML() {
  const p = target(); const existing = p.tracks.map(D.track).filter(Boolean);
  const dupes = S.selection.filter(s => inTarget(s.uri) && !S.keep.has(s.uri));
  const total = existing.reduce((a, t) => a + t.duration, 0) + S.selection.reduce((a, s) => a + (s.track.duration || 0), 0);
  return `<div class="thead">${p.image ? `<img class="art" src="${esc(p.image)}" alt="">` : `<div class="art"></div>`}
      <div class="meta"><div class="title">${esc(p.name)}</div><div class="sub">${p.total + newCount()} songs · ${fmtDur(total)}${S.selection.length ? ` · ${newCount()} unpublished` : ""}</div></div>
      <button class="switch" data-action="switch">Switch ⌄</button></div>
    ${dupes.map(s => `<div class="banner amber"><span>⚠︎ ${esc(s.track.name)} is already in this playlist</span><span class="spacer"></span><button data-keep="${esc(s.uri)}">Keep both</button><button data-remove="${esc(s.uri)}">Skip</button></div>`).join("")}
    ${S.selection.length ? section(`New · ${S.selection.length} · drag to reorder, ✕ to remove`) + `<div id="newlist">${S.selection.map(s => rowHTML(s.track, { mode: "review", sub: `${artists(s.track)} · from ${s.source}`, trail: inTarget(s.uri) ? { text: S.keep.has(s.uri) ? "dupe, keeping" : "dupe", cls: "amber" } : { text: "new", cls: "green" } })).join("")}</div>` : `<div class="empty">Nothing selected yet. Go to Find and tap + on any song.</div>`}
    ${section(`Already in ${p.name} · ${existing.length}`)}
    ${existing.length ? existing.map(t => rowHTML(t, { mode: "plain", sub: artists(t) })).join("") : `<div class="empty">Empty playlist so far.</div>`}`;
}

// ---------- sheets ----------
function sheetHTML() {
  if (S.sheet === "switch") return `<div class="scrim" data-action="closesheet"><div class="sheet" onclick="event.stopPropagation()"><div class="grab"></div><h2>Build which playlist?</h2>
    <div class="row tappable" data-action="start-new"><div class="art" style="display:grid;place-items:center;font-size:22px">＋</div><div class="meta"><div class="title">New playlist</div><div class="sub">Create one in Spotify and start adding</div></div></div>
    ${lib.playlists.filter(p => p.mine).map(p => playlistRowHTML(p, "data-set-target")).join("")}</div></div>`;
  if (S.sheet === "settings") return `<div class="scrim" data-action="closesheet"><div class="sheet" onclick="event.stopPropagation()"><div class="grab"></div><h2>Claude API key</h2>
    <p class="empty" style="text-align:left;padding-top:0">Used only from this browser to ask Claude what to add. Stored locally, never sent anywhere but Anthropic.</p>
    <div class="field"><input id="akey" type="password" placeholder="sk-ant-…" value="${esc(AI.getKey())}" autocomplete="off"></div>
    <div style="display:flex;gap:10px;padding:12px 16px 0"><button class="btn green" data-action="savekey">Save</button>${AI.getKey() ? `<button class="btn ghost" data-action="clearkey">Remove</button>` : ""}</div></div></div>`;
  return "";
}

// ---------- main render ----------
function render() {
  const sc = S.screen;
  if (sc.name === "start") { $app.innerHTML = startHTML(); return; }
  if (sc.name === "new") { $app.innerHTML = `<div class="head stacked"><button class="back" data-back aria-label="Back">‹</button></div>` + newHTML(); document.getElementById("pname")?.focus(); return; }
  if (sc.name === "existing") { $app.innerHTML = headHTML("Your playlists", true) + existingHTML(); return; }
  if (!target()) { S.screen = { name: "start" }; S.stack = []; return render(); }
  const titles = { home: "Playlist Mode", search: "Search", playlist: D.playlist(sc.id)?.name || "Playlist", artist: lib.artists.get(sc.id)?.name || "Artist", "catalog-artist": sc.artist?.name || "Artist", artists: "Your artists", playlists: "Your playlists", recents: "Recently played", review: "Playlist Mode" };
  const bodies = { home: homeHTML, search: searchHTML, playlist: playlistHTML, artist: artistHTML, "catalog-artist": catalogArtistHTML, artists: artistsHTML, playlists: playlistsHTML, recents: recentsHTML, review: reviewHTML };
  const withBack = !["home", "review"].includes(sc.name);
  const right = withBack ? "" : `<button class="kbd" data-action="reload" title="Reload library">↻</button>`;
  const active = document.activeElement?.id, selStart = document.activeElement?.selectionStart;
  $app.innerHTML = `${bannerHTML()}${headHTML(titles[sc.name], withBack, right)}${segHTML()}<div class="body">${bodies[sc.name]()}</div>${ctaHTML()}${sheetHTML()}`;
  if (active) { const el = document.getElementById(active); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
}

// ---------- events ----------
$app.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-select],[data-deselect],[data-toggle],[data-remove],[data-keep],[data-dismiss],[data-open-playlist],[data-open-artist],[data-open-catalog-artist],[data-set-target],[data-chip],[data-back],[data-action]");
  if (!t) return;
  const d = t.dataset;
  const trackOf = (uri) => D.track(uri) || S.recents.find(x => x.uri === uri) || S.catalog.tracks.find(x => x.uri === uri) || (S.screen.tracks || []).find(x => x.uri === uri) || S.ai.items.find(x => x.uri === uri) || (S.nowPlaying?.track.uri === uri ? S.nowPlaying.track : null);
  const sourceName = (uri) => S.nowPlaying?.track.uri === uri ? "now playing" : S.ai.items.some(x => x.uri === uri) && S.screen.name === "home" ? "Claude's suggestion" : ({ home: "your playlists", recents: "recents", search: "search", playlist: D.playlist(S.screen.id)?.name, artist: lib.artists.get(S.screen.id)?.name, "catalog-artist": S.screen.artist?.name })[S.screen.name] || "library";
  if (d.select) { const tr = trackOf(d.select); if (tr) select(tr, sourceName(d.select)); return; }
  if (d.deselect) return deselect(d.deselect);
  if (d.toggle) { const tr = trackOf(d.toggle); if (tr) toggle(tr, sourceName(d.toggle)); return; }
  if (d.remove) { const s = S.selection.find(x => x.uri === d.remove); deselect(d.remove); if (s && S.screen.name === "review") toast(`Removed ${s.track.name}`, "Undo", () => { S.selection.push(s); persistSel(); render(); }); return; }
  if (d.keep) { S.keep.add(d.keep); return render(); }
  if (d.dismiss) { S.ai.dismissed.add(d.dismiss); return render(); }
  if (d.openPlaylist) return go({ name: "playlist", id: d.openPlaylist });
  if (d.openArtist) return go({ name: "artist", id: d.openArtist });
  if (d.openCatalogArtist) {
    const a = S.catalog.artists.find(x => x.id === d.openCatalogArtist) || { id: d.openCatalogArtist, name: "Artist", image: "" };
    const screen = { name: "catalog-artist", artist: a, tracks: null }; go(screen);
    D.artistTopTracks(a.id, a.name).then(tr => { if (S.screen === screen) { screen.tracks = tr; render(); } }).catch(err => { screen.tracks = []; render(); toast(err.message); });
    return;
  }
  if (d.setTarget) { setTarget(d.setTarget); S.sheet = null; S.selection = []; persistSel(); home(); return; }
  if (d.chip !== undefined) { S.screen.artist = d.chip || null; return render(); }
  if (t.hasAttribute("data-back")) return back();
  switch (d.action) {
    case "start-new": S.sheet = null; return go({ name: "new", value: "" });
    case "start-existing": return go({ name: "existing" });
    case "create": {
      const name = (S.screen.value || "").trim(); if (!name) return;
      t.disabled = true; t.textContent = "Creating…";
      try { const p = await D.createPlaylist(name); setTarget(p.id); S.selection = []; persistSel(); home(); toast(`Created “${p.name}” in Spotify`); }
      catch (err) { render(); toast(`Couldn’t create: ${err.message}`); }
      return;
    }
    case "find": return S.screen.name === "review" ? (S.stack.length ? back() : home()) : home();
    case "review": if (S.screen.name !== "review") go({ name: "review" }); return;
    case "artists": return go({ name: "artists" });
    case "playlists": return go({ name: "playlists" });
    case "recents": return go({ name: "recents" });
    case "switch": S.sheet = "switch"; return render();
    case "settings": S.sheet = "settings"; render(); document.getElementById("akey")?.focus(); return;
    case "closesheet": S.sheet = null; return render();
    case "savekey": AI.setKey(document.getElementById("akey")?.value || ""); AI.resetClient(); S.sheet = null; S.ai.status = "idle"; render(); loadSuggestions(true); return;
    case "clearkey": AI.setKey(""); AI.resetClient(); S.sheet = null; S.ai = { status: "idle", items: [], error: "", forTarget: null, dismissed: new Set() }; return render();
    case "ai-refresh": return loadSuggestions(true);
    case "more-results": {
      const q = S.screen.q; if (S.catalog.loading) return; S.catalog.loading = true; render();
      try { const more = await D.searchCatalog(q, S.catalog.tracks.length); if (S.catalogQ === q) { S.catalog.tracks.push(...more.filter(t => !S.catalog.tracks.some(x => x.uri === t.uri))); S.catalog.done = more.length < 10; } }
      catch (err) { toast(err.message); } finally { S.catalog.loading = false; if (S.screen.name === "search") render(); }
      return;
    }
    case "clearq": S.screen = { name: "home" }; S.stack = []; render(); document.getElementById("q")?.focus(); return;
    case "selectall": {
      let tracks = [];
      if (S.screen.name === "playlist") { const p = D.playlist(S.screen.id); tracks = p.tracks.map(D.track).filter(Boolean); if (S.screen.artist) tracks = tracks.filter(x => x.artists.some(a => a.id === S.screen.artist)); if (S.screen.filter) tracks = tracks.filter(x => matches(x, S.screen.filter)); }
      else if (S.screen.name === "artist") tracks = D.artistTracks(S.screen.id);
      else if (S.screen.name === "search") tracks = S.catalogQ === S.screen.q ? S.catalog.tracks : [];
      else if (S.screen.name === "catalog-artist") tracks = S.screen.tracks || [];
      for (const tr of tracks) if (!inTarget(tr.uri) && !isSelected(tr.uri)) S.selection.push({ uri: tr.uri, source: sourceName(tr.uri), track: tr });
      persistSel(); return render();
    }
    case "discard": { const saved = S.selection; S.selection = []; persistSel(); render(); toast(`Discarded ${saved.length}`, "Undo", () => { S.selection = saved; persistSel(); render(); }); return; }
    case "publish": return publish();
    case "reload": return boot(true);
  }
});
$app.addEventListener("input", (e) => {
  if (e.target.id === "q") {
    const q = e.target.value;
    if (!q.trim()) { S.screen = { name: "home" }; S.stack = []; render(); return; }
    if (S.screen.name !== "search") S.stack = [{ name: "home" }];
    S.screen = { name: "search", q }; render(); catalogSearch(q);
  }
  if (e.target.id === "pf") { S.screen.filter = e.target.value; render(); }
  if (e.target.id === "pname") { S.screen.value = e.target.value; const b = $app.querySelector("[data-action=create]"); if (b) b.disabled = !e.target.value.trim(); }
});
$app.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "pname") $app.querySelector("[data-action=create]")?.click(); });
let catalogTimer;
function catalogSearch(q) {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(async () => { try { const r = await D.searchAll(q); if (S.screen.name === "search" && S.screen.q === q) { S.catalog = r; S.catalogQ = q; render(); } } catch (e) { console.warn(e); } }, 350);
}
// drag-to-reorder in review
$app.addEventListener("pointerdown", (e) => { const h = e.target.closest("[data-handle]"); if (!h) return; const row = h.closest(".row"); S.dragFrom = row.dataset.uri; row.classList.add("dragging"); h.setPointerCapture(e.pointerId); e.preventDefault(); });
$app.addEventListener("pointermove", (e) => {
  if (!S.dragFrom) return;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("#newlist .row"); if (!over || over.dataset.uri === S.dragFrom) return;
  const from = S.selection.findIndex(s => s.uri === S.dragFrom), to = S.selection.findIndex(s => s.uri === over.dataset.uri); if (from < 0 || to < 0) return;
  const [m] = S.selection.splice(from, 1); S.selection.splice(to, 0, m);
  const rows = [...document.getElementById("newlist").children]; const moving = rows[from]; if (from < to) rows[to].after(moving); else rows[to].before(moving);
});
$app.addEventListener("pointerup", () => { if (!S.dragFrom) return; S.dragFrom = null; persistSel(); render(); });

// ---------- publish / undo ----------
async function publish() {
  const p = target(); if (!p) return;
  const items = S.selection.filter(s => !inTarget(s.uri) || S.keep.has(s.uri)); if (!items.length) return;
  const btn = $app.querySelector("[data-action=publish]"); if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  try {
    for (let i = 0; i < items.length; i += 100) await api(`/playlists/${p.id}/items`, { method: "POST", body: { uris: items.slice(i, i + 100).map(s => s.uri) } });
    D.addToPlaylistLocal(p.id, items.map(s => s.track));
    S.lastPublish = { playlistId: p.id, uris: items.map(s => s.uri) };
    S.selection = []; S.keep = new Set(); persistSel(); S.ai.items = S.ai.items.filter(t => !inTarget(t.uri)); render();
    toast(`Added ${items.length} to ${p.name}`, "Undo", undoPublish, 8000);
  } catch (e) { render(); toast(`Publish failed: ${e.message}`); }
}
async function undoPublish() {
  const u = S.lastPublish; if (!u) return;
  try { await api(`/playlists/${u.playlistId}/items`, { method: "DELETE", body: { items: u.uris.map(uri => ({ uri })) } }); D.removeFromPlaylistLocal(u.playlistId, u.uris); S.lastPublish = null; render(); toast(`Removed ${u.uris.length} again`); }
  catch (e) { toast(`Undo failed: ${e.message}`); }
}

// ---------- live data ----------
let npTimer;
async function pollNowPlaying() {
  clearTimeout(npTimer);
  try { const np = await D.nowPlaying(); const changed = np?.track.uri !== S.nowPlaying?.track.uri || np?.playing !== S.nowPlaying?.playing; S.nowPlaying = np; if (changed && S.screen.name === "home") { const el = document.getElementById("np"); if (el) el.innerHTML = np ? npCardHTML(np) : ""; } } catch (e) { console.warn(e); }
  npTimer = setTimeout(pollNowPlaying, 5000);
}

// ---------- boot ----------
function splash(html) { $app.innerHTML = `<div class="splash">${html}</div>`; }
async function boot(force = false) {
  try { await handleCallback(); } catch (e) { splash(`<h1>Playlist Mode</h1><p>Login failed: ${esc(e.message)}</p><button class="btn green" data-login>Try again</button>`); return; }
  if (!getStoredToken()) { splash(`<h1>Playlist Mode</h1><p>Build playlists from the music you already have, with a little help. Pick a playlist once, then every song is one tap.</p><button class="btn green" data-login>Log in with Spotify</button>`); return; }
  const cached = !force && D.loadCache();
  if (!cached || D.isStale()) {
    splash(`<h1>Loading your library</h1><p id="pl">Reading your playlists…</p><div class="progress"><div id="pb" style="width:0%"></div></div>`);
    try { await D.loadLibrary(({ done, total, label }) => { const pb = document.getElementById("pb"), pl = document.getElementById("pl"); if (pb) pb.style.width = `${(done / total) * 100}%`; if (pl) pl.textContent = `${done} / ${total} · ${label}`; }); }
    catch (e) { if (e.status === 401 || /expired|Not logged/.test(e.message)) { logout(); return boot(); } splash(`<h1>Couldn’t load</h1><p>${esc(e.message)}</p><button class="btn green" data-reload>Retry</button>`); return; }
  }
  if (S.target && !D.playlist(S.target)) S.target = null;
  S.selection = S.selection.filter(s => s.track);
  S.screen = S.target ? { name: "home" } : { name: "start" }; S.stack = [];
  render();
  D.recentlyPlayed().then(r => { S.recents = r; if (S.screen.name === "home") render(); }).catch(console.warn);
  // now-playing capture and Claude suggestions are parked for now (see decisions log)
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-login]")) login(); if (e.target.closest("[data-reload]")) boot(true); });
boot();
