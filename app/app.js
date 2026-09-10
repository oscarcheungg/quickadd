import { login, logout, handleCallback, getStoredToken, api } from "./spotify.js";
import * as D from "./data.js";
const { lib } = D;

// ---------- state ----------
const S = {
  screen: { name: "home" }, stack: [],
  target: localStorage.getItem("qa.target") || null,
  selection: JSON.parse(sessionStorage.getItem("qa.sel") || "[]"), // [{uri, source, track}]
  keep: new Set(),            // uris the user chose to add even though already in target
  nowPlaying: null, recents: [], catalog: [], catalogQ: "",
  lastPublish: null, lastRemoved: null, sheet: null, dragFrom: null,
};
const $app = document.getElementById("app");
const $toast = document.getElementById("toast");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} min`; };
const artists = (t) => t.artists.map(a => a.name).join(", ");
const initials = (n) => n.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const ago = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60000; return m < 60 ? `${Math.max(1, Math.round(m))} m ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const persistSel = () => sessionStorage.setItem("qa.sel", JSON.stringify(S.selection));

// ---------- selection ----------
const target = () => D.playlist(S.target);
const isSelected = (uri) => S.selection.some(s => s.uri === uri);
const inTarget = (uri) => D.inPlaylist(uri, S.target);
function select(track, source) {
  if (isSelected(track.uri)) return;
  S.selection.push({ uri: track.uri, source, track });
  persistSel(); render();
}
function deselect(uri) { S.selection = S.selection.filter(s => s.uri !== uri); persistSel(); render(); }
function toggle(track, source) { isSelected(track.uri) ? deselect(track.uri) : select(track, source); }
const newCount = () => S.selection.filter(s => !inTarget(s.uri) || S.keep.has(s.uri)).length;

// ---------- navigation ----------
function go(screen) { S.stack.push(S.screen); S.screen = screen; render(); $app.querySelector(".body")?.scrollTo(0, 0); }
function back() { S.screen = S.stack.pop() || { name: "home" }; render(); }
function home() { S.stack = []; S.screen = { name: "home" }; render(); }

// ---------- toast ----------
let toastTimer;
function toast(msg, action, fn, ms = 6000) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="ink" data-toast-action>${esc(action)}</button>` : ""}`;
  $toast.hidden = false;
  $toast.querySelector("[data-toast-action]")?.addEventListener("click", () => { $toast.hidden = true; fn?.(); });
  toastTimer = setTimeout(() => { $toast.hidden = true; }, ms);
}

// ---------- render helpers ----------
function rowHTML(t, { mode = "plus", sub, trail, extra = "", cls = "" } = {}) {
  const inT = inTarget(t.uri), sel = isSelected(t.uri);
  const where = D.playlistsFor(t.uri).filter(p => p.id !== S.target).map(p => p.name);
  const subText = sub ?? [artists(t), where.length ? `in ${where.slice(0, 2).join(", ")}${where.length > 2 ? ` +${where.length - 2}` : ""}` : ""].filter(Boolean).join(" · ");
  let ctrl = "";
  if (mode === "plus") ctrl = inT ? `<span class="plus done" title="Already in ${esc(target()?.name)}">✓</span>` : sel ? `<button class="plus pending" data-deselect="${esc(t.uri)}">✓</button>` : `<button class="plus" data-select="${esc(t.uri)}">+</button>`;
  else if (mode === "check") ctrl = inT ? `<span class="check on disabled">✓</span>` : `<span class="check ${sel ? "on" : ""}">${sel ? "✓" : ""}</span>`;
  else if (mode === "review") ctrl = `<button class="x" data-remove="${esc(t.uri)}">✕</button>`;
  const trailHTML = trail ? `<span class="trail ${trail.cls || ""}">${esc(trail.text)}</span>` : (inT && mode !== "review" ? `<span class="trail green">in ${esc(target()?.name)}</span>` : "");
  return `<div class="row ${sel && mode === "check" ? "selected" : ""} ${mode === "check" && !inT ? "tappable" : ""} ${cls}" data-uri="${esc(t.uri)}" ${mode === "check" && !inT ? `data-toggle="${esc(t.uri)}"` : ""}>
    ${mode === "review" ? `<span class="handle" data-handle>≡</span>` : ""}
    ${mode === "check" ? ctrl : ""}
    ${t.image ? `<img class="art" src="${esc(t.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title ${inT ? "in-target" : ""}">${esc(t.name)}</div><div class="sub">${esc(subText)}</div></div>
    ${trailHTML}${extra}
    ${mode !== "check" ? ctrl : ""}
  </div>`;
}
const section = (label, action) => `<div class="section"><span>${esc(label)}</span><span class="spacer"></span>${action ? `<button data-action="${esc(action.id)}">${esc(action.label)}</button>` : ""}</div>`;
function playlistRowHTML(p) {
  return `<div class="row tappable" data-open-playlist="${esc(p.id)}">${p.image ? `<img class="art" src="${esc(p.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title">${esc(p.name)}</div><div class="sub">${p.total} songs${p.lastAdded ? ` · edited ${ago(new Date(p.lastAdded).toISOString())}` : ""}</div></div><span class="chev">›</span></div>`;
}
function artistCardHTML(a) {
  return `<button class="artist" data-open-artist="${esc(a.id)}"><div class="avatar">${esc(initials(a.name))}</div><div class="name">${esc(a.name)}</div><div class="count">${a.uris.size} saved</div></button>`;
}
function headHTML(title, withBack) {
  return `<div class="head">${withBack ? `<button class="back" data-back>‹ Back</button>` : ""}<h1>${esc(title)}</h1>${!withBack ? `<button class="kbd" data-action="reload" title="Reload library">↻</button>` : ""}</div>`;
}
function segHTML() {
  const n = S.selection.length, t = target();
  const isReview = S.screen.name === "review";
  return `<div class="seg"><button class="${!isReview ? "on" : ""}" data-action="find">Find${n ? ` · ${n} selected` : ""}</button><button class="${isReview ? "on target" : ""}" data-action="review">${esc(t?.name || "Choose playlist")}${t ? ` · ${t.total}` : ""}</button></div>`;
}
function ctaHTML() {
  const n = S.selection.length, t = target();
  if (S.screen.name === "review") {
    const k = newCount();
    return `<div class="cta">${n ? `<button class="btn ghost" data-action="discard">Discard ${n}</button>` : ""}<button class="btn green" data-action="publish" ${k ? "" : "disabled"}>${k ? `Publish ${k} to Spotify` : "Nothing new to publish"}</button></div>`;
  }
  return `<div class="cta"><button class="btn" data-action="review" ${n ? "" : "disabled"}>${n ? `Review ${n} in ${esc(t?.name)} →` : `Pick songs to add to ${esc(t?.name || "a playlist")}`}</button></div>`;
}

// ---------- screens ----------
function homeHTML() {
  const np = S.nowPlaying;
  const lists = lib.playlists.slice(0, 3);
  return `${searchFieldHTML("")}
    <div id="np">${np ? npCardHTML(np) : ""}</div>
    ${section("Your artists", { id: "artists", label: "See all" })}
    <div class="hscroll">${D.topArtists(10).map(artistCardHTML).join("")}</div>
    ${section("Your playlists · last edited first", { id: "playlists", label: `See all ${lib.playlists.length}` })}
    ${lists.map(playlistRowHTML).join("")}
    ${section("Recently played")}
    <div id="recents">${S.recents.length ? S.recents.slice(0, 15).map(t => rowHTML(t, { sub: `${artists(t)} · ${ago(t.playedAt)}` })).join("") : `<div class="empty">Nothing played recently.</div>`}</div>`;
}
function npCardHTML(np) {
  const t = np.track, inT = inTarget(t.uri), sel = isSelected(t.uri);
  return `${section(np.playing ? "Now playing" : "Paused")}<div class="card">${t.image ? `<img class="art" src="${esc(t.image)}" alt="">` : `<div class="art"></div>`}
    <div class="meta"><div class="title">${esc(t.name)}</div><div class="sub">${esc(artists(t))}</div></div>
    ${inT ? `<span class="pill done">✓ in ${esc(target()?.name)}</span>` : sel ? `<button class="pill" data-deselect="${esc(t.uri)}">✓ Added</button>` : `<button class="pill" data-select="${esc(t.uri)}">+ Add</button>`}</div>`;
}
function searchFieldHTML(q) {
  return `<div class="field"><span class="muted">⌕</span><input id="q" type="search" placeholder="Any song, artist, or one of your playlists" value="${esc(q)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">${q ? `<button class="clear" data-action="clearq">✕</button>` : ""}</div>`;
}
function searchHTML() {
  const q = S.screen.q || "";
  const lists = D.searchPlaylists(q), hits = D.searchLibrary(q);
  const libUris = new Set(hits.map(t => t.uri));
  const recents = S.recents.filter(t => !libUris.has(t.uri) && D.searchLibrary(q).length < 40 && matches(t, q)).slice(0, 5);
  const catalog = S.catalogQ === q ? S.catalog.filter(t => !libUris.has(t.uri)) : [];
  const selectable = hits.filter(t => !inTarget(t.uri));
  return `${searchFieldHTML(q)}
    ${lists.length ? section("Your playlists") + lists.map(playlistRowHTML).join("") : ""}
    ${section(`In your playlists · ${hits.length}`, selectable.length > 1 ? { id: "selectall", label: `Select all ${selectable.length}` } : null)}
    ${hits.length ? hits.map(t => rowHTML(t)).join("") : `<div class="empty">Nothing in your library matches “${esc(q)}”.</div>`}
    ${recents.length ? section("Recently played") + recents.map(t => rowHTML(t)).join("") : ""}
    ${section("On Spotify")}
    <div id="catalog">${catalog.length ? catalog.map(t => rowHTML(t, { sub: artists(t), trail: { text: "not in your library" } })).join("") : `<div class="empty">${S.catalogQ === q ? "No catalog results." : "Searching Spotify…"}</div>`}</div>`;
}
const matches = (t, q) => { const n = q.toLowerCase(); return (t.name + " " + artists(t)).toLowerCase().includes(n); };
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
function artistsHTML() { return `${section("By songs saved")}${D.topArtists(200).map(a => `<div class="row tappable" data-open-artist="${esc(a.id)}"><div class="art round" style="display:grid;place-items:center;font-weight:700;color:var(--muted)">${esc(initials(a.name))}</div><div class="meta"><div class="title">${esc(a.name)}</div><div class="sub">${a.uris.size} saved</div></div><span class="chev">›</span></div>`).join("")}`; }
function playlistsHTML() { return `${section("Last edited first")}${lib.playlists.map(playlistRowHTML).join("")}`; }
function reviewHTML() {
  const p = target(); if (!p) return `<div class="empty">Choose a playlist to build.</div>`;
  const existing = p.tracks.map(D.track).filter(Boolean);
  const dupes = S.selection.filter(s => inTarget(s.uri) && !S.keep.has(s.uri));
  const total = existing.reduce((a, t) => a + t.duration, 0) + S.selection.reduce((a, s) => a + (s.track.duration || 0), 0);
  return `<div class="thead">${p.image ? `<img class="art" src="${esc(p.image)}" alt="">` : `<div class="art"></div>`}
      <div class="meta"><div class="title">${esc(p.name)}</div><div class="sub">${p.total + newCount()} songs · ${fmtDur(total)}${S.selection.length ? ` · ${newCount()} unpublished` : ""}</div></div>
      <button class="switch" data-action="switch">Switch ⌄</button></div>
    ${dupes.map(s => `<div class="banner amber"><span>⚠︎ ${esc(s.track.name)} is already in this playlist</span><span class="spacer"></span><button data-keep="${esc(s.uri)}">Keep both</button><button data-remove="${esc(s.uri)}">Skip</button></div>`).join("")}
    ${S.selection.length ? section(`New · ${S.selection.length} · drag to reorder, ✕ to remove`) + `<div id="newlist">${S.selection.map(s => rowHTML(s.track, { mode: "review", sub: `${artists(s.track)} · from ${esc(s.source)}`, trail: inTarget(s.uri) ? { text: S.keep.has(s.uri) ? "dupe, keeping" : "dupe", cls: "amber" } : { text: "new", cls: "green" } })).join("")}</div>` : `<div class="empty">Nothing selected yet. Go to Find and tap + on any song.</div>`}
    ${section(`Already in ${p.name} · ${existing.length}`)}
    ${existing.length ? existing.map(t => rowHTML(t, { mode: "plain", sub: artists(t) })).join("") : `<div class="empty">Empty playlist.</div>`}`;
}
function sheetHTML() {
  if (S.sheet !== "switch") return "";
  return `<div class="scrim" data-action="closesheet"><div class="sheet" onclick="event.stopPropagation()"><div class="grab"></div><h2>Build which playlist?</h2>
    ${lib.playlists.filter(p => p.mine || p.collaborative).map(p => `<div class="row tappable" data-set-target="${esc(p.id)}">${p.image ? `<img class="art" src="${esc(p.image)}" alt="">` : `<div class="art"></div>`}<div class="meta"><div class="title ${p.id === S.target ? "in-target" : ""}">${esc(p.name)}</div><div class="sub">${p.total} songs</div></div>${p.id === S.target ? `<span class="trail green">building</span>` : ""}</div>`).join("")}</div></div>`;
}

// ---------- main render ----------
function render() {
  const sc = S.screen;
  const titles = { home: "Quick Add", search: "Search", playlist: D.playlist(sc.id)?.name || "Playlist", artist: lib.artists.get(sc.id)?.name || "Artist", artists: "Your artists", playlists: "Your playlists", review: "Quick Add" };
  const bodies = { home: homeHTML, search: searchHTML, playlist: playlistHTML, artist: artistHTML, artists: artistsHTML, playlists: playlistsHTML, review: reviewHTML };
  const withBack = !["home", "review"].includes(sc.name);
  const active = document.activeElement?.id, selStart = document.activeElement?.selectionStart;
  $app.innerHTML = `${headHTML(titles[sc.name], withBack)}${segHTML()}<div class="body">${bodies[sc.name]()}</div>${ctaHTML()}${sheetHTML()}`;
  if (active) { const el = document.getElementById(active); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
}

// ---------- events (delegated) ----------
$app.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-select],[data-deselect],[data-toggle],[data-remove],[data-keep],[data-open-playlist],[data-open-artist],[data-set-target],[data-chip],[data-back],[data-action]");
  if (!t) return;
  const d = t.dataset;
  const trackOf = (uri) => D.track(uri) || S.recents.find(x => x.uri === uri) || S.catalog.find(x => x.uri === uri) || (S.nowPlaying?.track.uri === uri ? S.nowPlaying.track : null);
  const sourceName = () => ({ home: "recents", search: "search", playlist: D.playlist(S.screen.id)?.name, artist: lib.artists.get(S.screen.id)?.name, review: "review" })[S.screen.name] || "library";
  if (d.select) { const tr = trackOf(d.select); if (tr) select(tr, S.nowPlaying?.track.uri === d.select ? "now playing" : sourceName()); return; }
  if (d.deselect) return deselect(d.deselect);
  if (d.toggle) { if (e.target.closest("[data-open-playlist],[data-open-artist]")) return; const tr = trackOf(d.toggle); if (tr) toggle(tr, sourceName()); return; }
  if (d.remove) { const s = S.selection.find(x => x.uri === d.remove); deselect(d.remove); if (s && S.screen.name === "review") toast(`Removed ${s.track.name}`, "Undo", () => { S.selection.push(s); persistSel(); render(); }); return; }
  if (d.keep) { S.keep.add(d.keep); return render(); }
  if (d.openPlaylist) return go({ name: "playlist", id: d.openPlaylist });
  if (d.openArtist) return go({ name: "artist", id: d.openArtist });
  if (d.setTarget) { S.target = d.setTarget; localStorage.setItem("qa.target", S.target); S.sheet = null; S.keep = new Set(); return render(); }
  if (d.chip !== undefined) { S.screen.artist = d.chip || null; return render(); }
  if (t.hasAttribute("data-back")) return back();
  switch (d.action) {
    case "find": return S.screen.name === "review" ? (S.stack.length && S.stack.at(-1).name !== "review" ? back() : home()) : home();
    case "review": if (S.screen.name !== "review") go({ name: "review" }); return;
    case "artists": return go({ name: "artists" });
    case "playlists": return go({ name: "playlists" });
    case "switch": S.sheet = "switch"; return render();
    case "closesheet": S.sheet = null; return render();
    case "clearq": S.screen = { name: "home" }; render(); document.getElementById("q")?.focus(); return;
    case "selectall": {
      let tracks = [];
      if (S.screen.name === "playlist") { const p = D.playlist(S.screen.id); tracks = p.tracks.map(D.track).filter(Boolean); if (S.screen.artist) tracks = tracks.filter(x => x.artists.some(a => a.id === S.screen.artist)); if (S.screen.filter) tracks = tracks.filter(x => matches(x, S.screen.filter)); }
      else if (S.screen.name === "artist") tracks = D.artistTracks(S.screen.id);
      else if (S.screen.name === "search") tracks = D.searchLibrary(S.screen.q);
      for (const tr of tracks) if (!inTarget(tr.uri) && !isSelected(tr.uri)) S.selection.push({ uri: tr.uri, source: sourceName(), track: tr });
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
    if (S.screen.name !== "search") { S.stack = [{ name: "home" }]; }
    S.screen = { name: "search", q }; render(); catalogSearch(q);
  }
  if (e.target.id === "pf") { S.screen.filter = e.target.value; render(); }
});
let catalogTimer;
function catalogSearch(q) {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(async () => {
    try { const r = await D.searchCatalog(q); if (S.screen.name === "search" && S.screen.q === q) { S.catalog = r; S.catalogQ = q; render(); } } catch (e) { console.warn(e); }
  }, 350);
}

// drag-to-reorder in review (pointer events on the ≡ handle)
$app.addEventListener("pointerdown", (e) => {
  const h = e.target.closest("[data-handle]"); if (!h) return;
  const row = h.closest(".row"); S.dragFrom = row.dataset.uri; row.classList.add("dragging"); h.setPointerCapture(e.pointerId); e.preventDefault();
});
$app.addEventListener("pointermove", (e) => {
  if (!S.dragFrom) return;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("#newlist .row"); if (!over || over.dataset.uri === S.dragFrom) return;
  const from = S.selection.findIndex(s => s.uri === S.dragFrom), to = S.selection.findIndex(s => s.uri === over.dataset.uri);
  if (from < 0 || to < 0) return;
  const [m] = S.selection.splice(from, 1); S.selection.splice(to, 0, m);
  const list = document.getElementById("newlist"); const rows = [...list.children]; const moving = rows[from];
  if (from < to) rows[to].after(moving); else rows[to].before(moving);
});
$app.addEventListener("pointerup", () => { if (!S.dragFrom) return; S.dragFrom = null; persistSel(); render(); });

// ---------- publish / undo ----------
async function publish() {
  const p = target(); if (!p) return;
  const items = S.selection.filter(s => !inTarget(s.uri) || S.keep.has(s.uri));
  if (!items.length) return;
  const btn = $app.querySelector("[data-action=publish]"); if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  try {
    for (let i = 0; i < items.length; i += 100) await api(`/playlists/${p.id}/items`, { method: "POST", body: { uris: items.slice(i, i + 100).map(s => s.uri) } });
    D.addToPlaylistLocal(p.id, items.map(s => s.track));
    S.lastPublish = { playlistId: p.id, uris: items.map(s => s.uri), names: items.map(s => s.track.name) };
    S.selection = []; S.keep = new Set(); persistSel(); render();
    toast(`Added ${items.length} to ${p.name}`, "Undo", undoPublish, 8000);
  } catch (e) { render(); toast(`Publish failed: ${e.message}`); }
}
async function undoPublish() {
  const u = S.lastPublish; if (!u) return;
  try {
    await api(`/playlists/${u.playlistId}/items`, { method: "DELETE", body: { items: u.uris.map(uri => ({ uri })) } });
    D.removeFromPlaylistLocal(u.playlistId, u.uris); S.lastPublish = null; render();
    toast(`Removed ${u.uris.length} again`);
  } catch (e) { toast(`Undo failed: ${e.message}`); }
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
  try { await handleCallback(); } catch (e) { splash(`<h1>Quick Add</h1><p>Login failed: ${esc(e.message)}</p><button class="btn green" data-login>Try again</button>`); }
  if (!getStoredToken()) { splash(`<h1>Quick Add</h1><p>Build playlists from the music you already have. Pick a playlist once, then every song is one tap.</p><button class="btn green" data-login>Log in with Spotify</button>`); return; }
  const cached = !force && D.loadCache();
  if (!cached || D.isStale()) {
    splash(`<h1>Loading your library</h1><p id="pl">Reading your playlists…</p><div class="progress"><div id="pb" style="width:0%"></div></div>`);
    try {
      await D.loadLibrary(({ done, total, label }) => { const pb = document.getElementById("pb"), pl = document.getElementById("pl"); if (pb) pb.style.width = `${(done / total) * 100}%`; if (pl) pl.textContent = `${done} / ${total} · ${label}`; });
    } catch (e) { if (e.status === 401 || /expired|Not logged/.test(e.message)) { logout(); return boot(); } splash(`<h1>Couldn’t load</h1><p>${esc(e.message)}</p><button class="btn green" data-reload>Retry</button>`); return; }
  }
  if (!S.target || !D.playlist(S.target)) { S.target = (lib.playlists.find(p => /test playlist/i.test(p.name)) || lib.playlists[0])?.id || null; if (S.target) localStorage.setItem("qa.target", S.target); }
  // drop selections whose tracks vanished
  S.selection = S.selection.filter(s => s.track);
  render();
  D.recentlyPlayed().then(r => { S.recents = r; if (S.screen.name === "home") render(); }).catch(console.warn);
  pollNowPlaying();
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-login]")) login(); if (e.target.closest("[data-reload]")) boot(true); });
boot();
