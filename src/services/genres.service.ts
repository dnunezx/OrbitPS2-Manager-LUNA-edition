import { downloadGameMetadata } from "./game-metadata.service";
import { readGameCfg, updateGameCfg } from "./cfg.service";
import { GENRE_LABELS, UNCATEGORIZED, genreFromCfg, normalizeGameId, normalizeGenre } from "../utils/genre";

export { GENRE_LABELS, UNCATEGORIZED, normalizeGenre };
export type GenreResult = { gameId: string; success: boolean; genre: string; changed?: boolean; message?: string };
type GenreLookup = (gameId: string, system: "PS1" | "PS2") => Promise<string>;
/** Use the same metadata database as the game-settings editor. */
export function downloadGenre(gameId: string, system: "PS1" | "PS2" = "PS2"): Promise<string> {
  const id = normalizeGameId(gameId);
  if (system !== "PS2") return Promise.resolve(UNCATEGORIZED);
  return downloadGameMetadata(id).then(genreFromCfg);
}

export async function readGameGenres(oplRoot: string, gameIds: string[]): Promise<GenreResult[]> {
  const results: GenreResult[] = [];
  for (const raw of Array.from(new Set(gameIds))) {
    try {
      const gameId = normalizeGameId(raw);
      const cfg = await readGameCfg(oplRoot, gameId);
      results.push({ gameId, success: cfg.success, genre: genreFromCfg(cfg.entries), message: cfg.message });
    } catch (error) { results.push({ gameId: raw, success: false, genre: UNCATEGORIZED, message: String(error) }); }
  }
  return results;
}

/** Empty/Uncategorized is an explicit assignment and suppresses auto-fill. */
export async function setGameGenre(oplRoot: string, raw: string, value: string, onlyIfMissing = false): Promise<GenreResult> {
  try {
    const gameId = normalizeGameId(raw);
    let genre = normalizeGenre(value), changed = false;
    const result = await updateGameCfg(oplRoot, gameId, (entries) => {
      const keys = Object.keys(entries).filter((key) => key.replace(/^#/, "").toLowerCase() === "genre");
      if (onlyIfMissing && keys.length) { genre = genreFromCfg(entries); return entries; }
      changed = keys.length !== 1 || keys[0] !== "Genre" || entries.Genre !== genre;
      if (!changed) return entries;
      const next = { ...entries };
      for (const key of keys) delete next[key];
      next.Genre = genre;
      return next;
    });
    return { gameId, success: result.success, genre, changed: result.success && changed, message: result.message };
  } catch (error) { return { gameId: raw, success: false, genre: UNCATEGORIZED, message: String(error) }; }
}

export async function assignGameGenres(oplRoot: string, gameIds: string[], genre: string): Promise<GenreResult[]> {
  const results: GenreResult[] = [];
  for (const gameId of Array.from(new Set(gameIds))) results.push(await setGameGenre(oplRoot, gameId, genre));
  return results;
}

/** Import only Genre; remote compatibility/VMC settings never enter local CFG. */
export async function fillGameGenres(oplRoot: string, gameIds: string[], system: "PS1" | "PS2" = "PS2", lookup: GenreLookup = downloadGenre): Promise<GenreResult[]> {
  const results: GenreResult[] = [];
  for (const raw of Array.from(new Set(gameIds))) {
    try {
      const gameId = normalizeGameId(raw);
      const current = await readGameCfg(oplRoot, gameId);
      if (!current.success) throw new Error(current.message);
      if (Object.keys(current.entries).some((key) => key.replace(/^#/, "").toLowerCase() === "genre")) {
        results.push({ gameId, success: true, genre: genreFromCfg(current.entries), changed: false }); continue;
      }
      const genre = normalizeGenre(await lookup(gameId, system));
      if (genre === UNCATEGORIZED) {
        results.push({ gameId, success: true, genre, changed: false }); continue;
      }
      // Re-read inside the per-CFG lock after lookup, preserving concurrent edits.
      results.push(await setGameGenre(oplRoot, gameId, genre, true));
    } catch (error) { results.push({ gameId: raw, success: false, genre: UNCATEGORIZED, message: String(error) }); }
  }
  return results;
}
