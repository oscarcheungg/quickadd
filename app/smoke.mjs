// Spotify Web API smoke test. No dependencies. Node 18+.
// NOTE: uses the Feb-2026 endpoints: POST /me/playlists and /playlists/{id}/items.
// The old /users/{id}/playlists and /playlists/{id}/tracks paths now return 403.
// Proves: login works, we can read currently-playing + playlists,
// and we can create a playlist and add a track that shows up in the real Spotify app.
//
// Setup (one time, ~3 min):
//   1. https://developer.spotify.com/dashboard  ->  Create app
//   2. Redirect URI: http://127.0.0.1:8888/callback   (must be 127.0.0.1, NOT localhost)
//   3. Which API/SDKs: tick "Web API"
//   4. Copy the Client ID
// Run:
//   SPOTIFY_CLIENT_ID=your_client_id node smoke.mjs
// Play any song in Spotify first so "currently playing" has something to read.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
if (!CLIENT_ID) { console.error("Set SPOTIFY_CLIENT_ID first."); process.exit(1); }

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");
const TOKEN_FILE = new URL("./token.json", import.meta.url);

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- 1. Login (Authorization Code + PKCE, no client secret needed) ----------
async function login() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI,
    scope: SCOPES, state, code_challenge_method: "S256", code_challenge: challenge,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const err = url.searchParams.get("error");
      if (err || url.searchParams.get("state") !== state) {
        res.end("Login failed: " + (err || "state mismatch")); server.close(); reject(new Error(err || "state mismatch")); return;
      }
      res.end("<h2>Logged in. You can close this tab and go back to the terminal.</h2>");
      server.close(); resolve(url.searchParams.get("code"));
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log("Opening Spotify login in your browser...");
      exec(`open "${authUrl}"`, (e) => e && console.log("Open this URL manually:\n" + authUrl));
    });
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, grant_type: "authorization_code", code,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Token exchange failed: " + JSON.stringify(tok));
  tok.expires_at = Date.now() + tok.expires_in * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 2));
  return tok;
}

async function refresh(tok) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: tok.refresh_token }),
  });
  const next = await res.json();
  if (!next.access_token) return login();
  next.refresh_token ||= tok.refresh_token;
  next.expires_at = Date.now() + next.expires_in * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function getToken() {
  if (!fs.existsSync(TOKEN_FILE)) return login();
  const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  return Date.now() < tok.expires_at - 60_000 ? tok : refresh(tok);
}

// ---------- 2. Tiny API helper ----------
let TOKEN;
async function api(path, opts = {}) {
  const res = await fetch("https://api.spotify.com/v1" + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const ok = (label, extra = "") => console.log(`  ✔ ${label}${extra ? "  " + extra : ""}`);

// ---------- 3. The checks ----------
TOKEN = await getToken();
console.log("\nRunning checks...\n");

const me = await api("/me");
ok("Logged in as", `${me.display_name} (${me.id})`);

const now = await api("/me/player/currently-playing");
if (now?.item) ok("Currently playing", `"${now.item.name}" by ${now.item.artists.map((a) => a.name).join(", ")}`);
else console.log("  – Nothing playing right now (that's fine; play a song and rerun to test this path)");

const recent = await api("/me/player/recently-played?limit=5");
ok("Recently played", recent.items.map((i) => i.track.name).join(" | "));

const top = await api("/me/top/tracks?limit=5&time_range=short_term");
ok("Top tracks (4 wks)", top.items.map((t) => t.name).join(" | "));

const lists = await api("/me/playlists?limit=50");
ok("Playlists readable", `${lists.total} total, e.g. ${lists.items.slice(0, 3).map((p) => `"${p.name}"`).join(", ")}`);

// Pick a track to add: what's playing, else most recent play.
const track = now?.item ?? recent.items[0].track;

// Create a throwaway playlist and add the track.
const pl = await api(`/me/playlists`, {
  method: "POST",
  body: JSON.stringify({ name: "Smoke test (delete me)", public: false, description: "Created by smoke.mjs" }),
});
ok("Created playlist", `"${pl.name}"  ${pl.external_urls.spotify}`);

await api(`/playlists/${pl.id}/items`, { method: "POST", body: JSON.stringify({ uris: [track.uri] }) });
ok("Added track", `"${track.name}"`);

const back = await api(`/playlists/${pl.id}/items?fields=items(item(name))`);
const found = back.items.some((i) => i.item?.name === track.name);
if (!found) throw new Error("Track did not read back from the new playlist");
ok("Read it back from Spotify", "open the Spotify app and it's there");

console.log(`
All good. Everything the one-tap app needs is working.
Delete "Smoke test (delete me)" from Spotify whenever you like.
Token saved to token.json (gitignore it) so the next run skips login.
`);
