import * as fs from "fs/promises";
import path from "path";
import { createLogger } from "../logger";

const log = createLogger("cfg");

/**
 * Per-game OPL config files (`CFG/<GAMEID>.cfg`).
 *
 * The format is one `KEY=VALUE` pair per line with CRLF endings. Keys carry
 * their sigil as part of the name, e.g. `#Name` (display title), `$Compatibility`
 * (mode bitmask), `$DMA`, `$VMC_0`. We read/write the whole map and never drop
 * keys we don't understand, so settings written by OPL itself (or other tools)
 * survive an edit here.
 */

export type GameCfg = Record<string, string>;

export function parseGameCfg(raw: string): GameCfg {
  const entries: GameCfg = {};
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key && key !== "__proto__") entries[key] = line.slice(eq + 1).trim();
  }
  return entries;
}

/** Reject paths targeting `.cfg.bak` backup files — never read them. */
const CFG_BAK_RE = /\.cfg\.bak$/i;

function assertNotBak(gameId: string): void {
  if (CFG_BAK_RE.test(gameId)) {
    throw new Error(`Refusing to operate on .cfg.bak path: ${gameId}`);
  }
}

function cfgPath(oplRoot: string, gameId: string): string {
  assertNotBak(gameId);
  if (!/^[A-Z]{4}_\d{3}\.\d{2}$/i.test(gameId)) throw new Error("Invalid game ID");
  return path.join(oplRoot, "CFG", `${gameId.toUpperCase()}.cfg`);
}

export async function readGameCfg(
  oplRoot: string,
  gameId: string
): Promise<{ success: boolean; entries: GameCfg; message?: string }> {
  try {
    assertNotBak(gameId);
    const raw = await fs.readFile(cfgPath(oplRoot, gameId), "utf-8");
    const entries = parseGameCfg(raw);
    const foundKeys = Object.keys(entries);
    log.verbose(`Read CFG for ${gameId}: ${foundKeys.length} key(s) [${foundKeys.join(", ")}]`);
    return { success: true, entries };
  } catch (err: any) {
    // A missing file simply means "no config yet" — not an error.
    if (err?.code === "ENOENT") {
      log.verbose(`No CFG file for ${gameId} yet`);
      return { success: true, entries: {} };
    }
    log.error(`Failed to read CFG for ${gameId}:`, err?.message || err);
    return { success: false, entries: {}, message: err?.message || String(err) };
  }
}

export async function writeGameCfg(
  oplRoot: string,
  gameId: string,
  entries: GameCfg
): Promise<{ success: boolean; message?: string }> {
  return withCfgLock(oplRoot, gameId, () => writeGameCfgUnlocked(oplRoot, gameId, entries));
}

const cfgWrites = new Map<string, Promise<unknown>>();
async function withCfgLock<T>(oplRoot: string, gameId: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(cfgPath(oplRoot, gameId)).toLowerCase();
  const previous = cfgWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  cfgWrites.set(key, current);
  try { return await current; }
  finally { if (cfgWrites.get(key) === current) cfgWrites.delete(key); }
}

export async function updateGameCfg(oplRoot: string, gameId: string,
  update: (entries: GameCfg) => GameCfg): Promise<{ success: boolean; message?: string }> {
  return withCfgLock(oplRoot, gameId, async () => {
    const current = await readGameCfg(oplRoot, gameId);
    if (!current.success) return current;
    const next = update(current.entries);
    if (next === current.entries) return { success: true };
    return writeGameCfgUnlocked(oplRoot, gameId, next);
  });
}

/** Merge only edited fields, preserving updates made while an editor was open. */
export async function patchGameCfg(oplRoot: string, gameId: string, changes: Record<string, string | null>): Promise<{ success: boolean; message?: string }> {
  return updateGameCfg(oplRoot, gameId, (entries) => {
    const next = { ...entries };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  });
}

async function writeGameCfgUnlocked(oplRoot: string, gameId: string, entries: GameCfg): Promise<{ success: boolean; message?: string }> {
  try {
    assertNotBak(gameId);
    const target = cfgPath(oplRoot, gameId);
    const keys = Object.keys(entries);
    if (keys.some((key) => !key || /[=\r\n]/.test(key) || typeof entries[key] !== "string" || /[\r\n]/.test(entries[key]))) {
      throw new Error("CFG entries must be single-line KEY=VALUE pairs");
    }

    // An empty config is equivalent to no config — remove the file.
    if (keys.length === 0) {
      await fs.rm(target, { force: true });
      log.info(`Cleared CFG for ${gameId} (no keys left — file removed)`);
      return { success: true };
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const body = keys.map((k) => `${k}=${entries[k]}`).join("\r\n") + "\r\n";
    const temporary = `${target}.tmp`;
    try {
      await fs.writeFile(temporary, body, "utf-8");
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    log.info(`Wrote CFG for ${gameId}: ${keys.length} key(s) [${keys.join(", ")}]`);
    return { success: true };
  } catch (err: any) {
    log.error(`Failed to write CFG for ${gameId}:`, err?.message || err);
    return { success: false, message: err?.message || String(err) };
  }
}
