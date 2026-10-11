import https from "https";
import { GameCfg, parseGameCfg, readGameCfg, updateGameCfg } from "./cfg.service";
import { genreFromCfg, normalizeGameId, normalizeGenre, UNCATEGORIZED } from "../utils/genre";

/** Only descriptive fields may be imported; never import remote OPL settings. */
export const METADATA_KEYS = ["Release", "Developer", "Description", "Genre", "Players", "PlayersText"] as const;
const downloads = new Map<string, Promise<GameCfg>>();

export function metadataFromCfg(entries: GameCfg): GameCfg {
  const metadata: GameCfg = {};
  for (const [key, value] of Object.entries(entries)) {
    const canonical = METADATA_KEYS.find((field) => field.toLowerCase() === key.replace(/^#/, "").toLowerCase());
    if (canonical && value.trim()) metadata[canonical] = value.trim();
  }
  return metadata;
}

/** A missing catalog entry is normal; failed requests can be retried. */
export function downloadGameMetadata(rawId: string): Promise<GameCfg> {
  const gameId = normalizeGameId(rawId);
  const cached = downloads.get(gameId);
  if (cached) return cached.then((entries) => ({ ...entries }));
  const pending = new Promise<GameCfg>((resolve, reject) => {
    const request = https.get(`https://raw.githubusercontent.com/t0mg/PS2-OPL-CFG-Database/master/CFG/${gameId}.cfg`, (response) => {
      if (response.statusCode === 404) { response.resume(); resolve({}); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Metadata database HTTP ${response.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) { response.destroy(new Error("Game metadata exceeds 64 KiB")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Metadata download interrupted")));
      response.on("end", () => resolve(metadataFromCfg(parseGameCfg(Buffer.concat(chunks).toString("utf8")))));
    });
    request.setTimeout(10000, () => request.destroy(new Error("Metadata database timed out")));
    request.on("error", reject);
  });
  downloads.set(gameId, pending);
  pending.catch(() => downloads.delete(gameId));
  return pending.then((entries) => ({ ...entries }));
}

export async function lookupGameMetadata(gameId: string): Promise<{ success: boolean; entries: GameCfg; message?: string }> {
  try { return { success: true, entries: await downloadGameMetadata(gameId) }; }
  catch (error) { return { success: false, entries: {}, message: error instanceof Error ? error.message : String(error) }; }
}

export type MetadataResult = { gameId: string; success: boolean; entries: GameCfg; genre: string; changed?: boolean; message?: string };
type MetadataLookup = (gameId: string) => Promise<GameCfg>;
const fields = ["Release", "Developer", "Description", "Genre", "Players"] as const;

function hasField(entries: GameCfg, field: string): boolean {
  return Object.entries(entries).some(([key, value]) => {
    const canonical = key.replace(/^#/, "").toLowerCase();
    // An explicit genre assignment (even empty) suppresses automatic lookup.
    if (field === "Genre" && canonical === "genre") return true;
    return value.trim() !== "" && (canonical === field.toLowerCase() || (field === "Players" && canonical === "playerstext"));
  });
}

/** Import descriptive metadata by default, preserving local and concurrent edits. */
export async function fillGameMetadata(oplRoot: string, gameIds: string[], system: "PS1" | "PS2" = "PS2", lookup: MetadataLookup = downloadGameMetadata): Promise<MetadataResult[]> {
  const results: MetadataResult[] = [];
  for (const rawId of Array.from(new Set(gameIds))) {
    try {
      const gameId = normalizeGameId(rawId);
      const current = await readGameCfg(oplRoot, gameId);
      if (!current.success) throw new Error(current.message);
      if (system !== "PS2" || fields.every((field) => hasField(current.entries, field))) {
        results.push({ gameId, success: true, entries: current.entries, genre: genreFromCfg(current.entries), changed: false });
        continue;
      }
      const downloaded = metadataFromCfg(await lookup(gameId));
      let finalEntries = current.entries, changed = false;
      const saved = await updateGameCfg(oplRoot, gameId, (entries) => {
        const next = { ...entries };
        for (const field of fields) {
          if (hasField(entries, field)) continue;
          const keys = field === "Players" ? ["Players", "PlayersText"] : [field];
          for (const key of keys) {
            let value = downloaded[key];
            if (!value) continue;
            if (key === "Genre") {
              value = normalizeGenre(value);
              if (value === UNCATEGORIZED) continue;
            }
            if (key === "Description") value = value.slice(0, 255);
            next[key] = value;
            changed = true;
          }
        }
        finalEntries = next;
        return changed ? next : entries;
      });
      results.push({ gameId, success: saved.success, entries: finalEntries, genre: genreFromCfg(finalEntries), changed: saved.success && changed, message: saved.message });
    } catch (error) {
      results.push({ gameId: rawId, success: false, entries: {}, genre: UNCATEGORIZED, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
