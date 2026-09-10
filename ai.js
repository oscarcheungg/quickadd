// Claude-powered suggestions for the playlist being built.
// The API key lives only in this browser (localStorage) — this is a personal, static app.
import { searchCatalog } from "./data.js";

const KEY = "qa.anthropic_key";
export const getKey = () => localStorage.getItem(KEY) || "";
export const setKey = (k) => (k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY));

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["suggestions"],
  properties: { suggestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "artist", "reason"],
    properties: { title: { type: "string" }, artist: { type: "string" }, reason: { type: "string", description: "One short sentence, under 12 words, on why it fits this playlist." } } } } },
};

let clientPromise;
async function client() {
  if (!clientPromise) clientPromise = import("https://esm.sh/@anthropic-ai/sdk").then(m => new m.default({ apiKey: getKey(), dangerouslyAllowBrowser: true }));
  return clientPromise;
}
export function resetClient() { clientPromise = null; }

// ctx: { name, tracks:[{name, artists:[{name}]}], topArtists:[names], avoid:[titles] }
export async function suggest(ctx, n = 10) {
  const c = await client();
  const list = ctx.tracks.slice(0, 60).map(t => `${t.name} — ${t.artists.map(a => a.name).join(", ")}`).join("\n");
  const user = `Playlist name: "${ctx.name}"
${ctx.tracks.length ? `Songs already in it (${ctx.tracks.length} total, first ${Math.min(60, ctx.tracks.length)} shown):\n${list}` : "The playlist is empty so far. Use its name and the listener's taste below."}

Listener's most-saved artists across their whole library: ${ctx.topArtists.slice(0, 15).join(", ") || "unknown"}.

Suggest ${n} real, existing songs to add next. Match the playlist's mood, era, and energy, not just the same artists: at most 3 suggestions may be by artists already in the playlist. Do not suggest anything already in it. Each reason must be a short, specific sentence a friend would say.`;
  const req = {
    model: "claude-opus-5", max_tokens: 2000,
    system: "You are a music curator helping someone extend one of their own Spotify playlists. Return only real songs that exist on Spotify, with exact titles and primary artist names so they can be looked up.",
    messages: [{ role: "user", content: user }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
  };
  let res;
  try { res = await c.beta.messages.create({ ...req, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }); }
  catch (e) { if (e?.status === 400) res = await c.messages.create(req); else throw e; }
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request");
  const text = res.content.find(b => b.type === "text")?.text || "{}";
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
  const items = (parsed.suggestions || []).slice(0, n);
  // Resolve each suggestion to a Spotify track, in parallel.
  const resolved = await Promise.all(items.map(async (s) => {
    try {
      const hits = await searchCatalog(`track:${s.title} artist:${s.artist}`);
      const hit = hits[0] || (await searchCatalog(`${s.title} ${s.artist}`))[0];
      return hit ? { ...hit, reason: s.reason, suggestedAs: `${s.title} — ${s.artist}` } : null;
    } catch { return null; }
  }));
  return resolved.filter(Boolean);
}
