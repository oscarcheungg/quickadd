// Spotify auth (PKCE, no secret) + a small API helper.
export const CLIENT_ID = "e791b3aef59b4eeab94c1984073ce632";
const REDIRECT_URI = location.origin + "/callback";
const SCOPES = ["user-read-currently-playing","user-read-recently-played","user-top-read","playlist-read-private","playlist-read-collaborative","playlist-modify-public","playlist-modify-private","ugc-image-upload"].join(" ");
const TOKEN_KEY = "qa.token";

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(str) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)); }
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function getStoredToken() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; } }
function storeToken(t) { t.expires_at = Date.now() + t.expires_in * 1000; localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); return t; }
export function logout() { localStorage.removeItem(TOKEN_KEY); }

export async function login() {
  const verifier = rand(64);
  const challenge = b64url(await sha256(verifier));
  const state = rand(16);
  sessionStorage.setItem("qa.pkce", JSON.stringify({ verifier, state }));
  const u = new URL("https://accounts.spotify.com/authorize");
  u.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: SCOPES, state, code_challenge_method: "S256", code_challenge: challenge });
  location.href = u.toString();
}

// Call on page load. Returns true if we just finished a login.
export async function handleCallback() {
  if (location.pathname !== "/callback") return false;
  const q = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem("qa.pkce") || "null");
  sessionStorage.removeItem("qa.pkce");
  history.replaceState(null, "", "/");
  if (!saved || q.get("state") !== saved.state || q.get("error")) throw new Error(q.get("error") || "Login state mismatch");
  const res = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT_URI, code_verifier: saved.verifier }) });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Token exchange failed");
  storeToken(tok);
  return true;
}

async function refresh(tok) {
  const res = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: tok.refresh_token }) });
  const next = await res.json();
  if (!next.access_token) { logout(); throw new Error("Session expired"); }
  next.refresh_token ||= tok.refresh_token;
  return storeToken(next);
}

export function hasScope(scope) { const t = getStoredToken(); return !!t?.scope?.split(" ").includes(scope); }

export async function accessToken() {
  let tok = getStoredToken();
  if (!tok) throw new Error("Not logged in");
  if (Date.now() > tok.expires_at - 60_000) tok = await refresh(tok);
  return tok.access_token;
}

// api("/me"), api("/playlists/x/items", {method:"POST", body:{uris}})
export async function api(path, opts = {}, _retry = 0) {
  const token = await accessToken();
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method: opts.method || "GET",
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 429 && _retry < 3) { const wait = (Number(res.headers.get("Retry-After")) || 1) * 1000; await new Promise(r => setTimeout(r, wait)); return api(path, opts, _retry + 1); }
  const body = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(`${opts.method || "GET"} ${path} → ${res.status} ${body?.error?.message || ""}`); e.status = res.status; throw e; }
  return body;
}

// Follow `next` links until done. Returns all items.
export async function apiAll(path, onPage) {
  let url = path, items = [];
  while (url) {
    const page = await api(url);
    items = items.concat(page.items || []);
    onPage?.(items.length, page.total);
    url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return items;
}
