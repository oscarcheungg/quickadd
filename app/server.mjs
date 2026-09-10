// Tiny static server for local dev. Serves this folder on http://127.0.0.1:8888
// and maps /callback (the Spotify redirect URI) to index.html.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = 8888;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname;
  if (p === "/" || p === "/callback") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`Playlist Mode dev server: http://127.0.0.1:${PORT}`));
