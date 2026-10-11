import * as fs from "fs/promises";
import path from "path";
import { mergeMultiBin } from "../utils/binmerge";
import { convertToVcd } from "../utils/cue2pops";
import { resolveCueBin } from "../utils/cue-parser";
import { extractSelectedDiscZip } from "../utils/zip-extract";
import { tryDeterminePs1GameIdFromHex, tryDeterminePs1GameIdFromVcd } from "./game-id-resolver.service";
import { constants } from "fs";
import { inspectCue, resolvePs1Source } from "./ps1-source.service";
import { validateVcd } from "../utils/psxcore-vcd";
import { requireSpace, assertAbsent, publishFile, uniqueVcdPath, ensureChildDirectory } from "../utils/safe-install";
import { downloadArtByGameId } from "./artwork.service";
import { sanitizeGameFilename } from "../utils/sanitize";
import { describeFileAccessError } from "../utils/file-access-error";
import { getAssetsDir } from "../utils/resource-path";
import { createLogger } from "../logger";

const log = createLogger("ps1-import");

// Prefix for auto-assigned IDs given to homebrew discs that carry no
// Sony-registered serial. Distinct from every prefix in PS1_GAME_ID_PREFIXES
// so it can never collide with a real detected game ID, while still matching
// the "<4 letters>_<3 digits>.<2 digits>" shape the library scanner expects
// to find at the front of a POPS/*.VCD filename.
const HOMEBREW_GAME_ID_PREFIX = "HBRW";

/**
 * Pick the lowest-numbered HBRW_###.## id that isn't already used by a file
 * in the POPS directory, so batch-importing many homebrew discs doesn't
 * assign the same id twice.
 */
async function generateHomebrewGameId(popsDir: string): Promise<string> {
  let existing: string[] = [];
  try {
    existing = await fs.readdir(popsDir);
  } catch {
    // POPS directory doesn't exist yet — nothing to conflict with.
  }

  const used = new Set<number>();
  const pattern = new RegExp(`^${HOMEBREW_GAME_ID_PREFIX}_(\\d{3})\\.(\\d{2})\\.`, "i");
  for (const name of existing) {
    const match = name.match(pattern);
    if (match) used.add(Number(match[1]) * 100 + Number(match[2]));
  }

  for (let n = 0; n < 10000; n++) {
    if (!used.has(n)) {
      const major = Math.floor(n / 100).toString().padStart(3, "0");
      const minor = (n % 100).toString().padStart(2, "0");
      return `${HOMEBREW_GAME_ID_PREFIX}_${major}.${minor}`;
    }
  }
  throw new Error("Exhausted available homebrew game ID slots.");
}

const POPSTARTER_ELF_CANDIDATE_PATHS = [
  path.join(getAssetsDir(), "POPSTARTER.ELF"),
  path.resolve(__dirname, "../assets/POPSTARTER.ELF"),
  path.resolve(__dirname, "../../assets/POPSTARTER.ELF"),
  path.resolve(process.cwd(), "assets/POPSTARTER.ELF"),
];

export async function findPopstarterElf(): Promise<string | null> {
  for (const candidate of POPSTARTER_ELF_CANDIDATE_PATHS) {
    try {
      await fs.access(candidate);
      log.verbose(`Using POPSTARTER.ELF at ${candidate}`);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export interface ImportPs1Result {
  success: boolean;
  message?: string;
  vcdPath?: string;
  gameId?: string;
  gameName?: string;
  readyToLaunch?: boolean;
}

export async function importPs1Game(
  source: string, oplRoot: string, elfPrefix: string, downloadArtwork: boolean,
  overrideGameId?: string, overrideGameName?: string,
  launcherMode: "popstarter" | "popsloader" | "psxcore" = "popstarter",
  onProgress?: (percent: number, stage: string) => void, archiveEntry?: string
): Promise<ImportPs1Result> {
  let zipTempDir: string | undefined, workDir: string | undefined;
  try {
    if (!["popstarter", "popsloader", "psxcore"].includes(launcherMode)) throw new Error("Unknown PS1 preparation mode.");
    const popsDir = path.join(oplRoot, "POPS"), artDir = path.join(oplRoot, "ART");
    await ensureChildDirectory(oplRoot, "POPS");
    let resolved = await resolvePs1Source(source);
    if (/\.zip$/i.test(resolved)) {
      onProgress?.(2, "Extracting selected disc");
      const extracted = await extractSelectedDiscZip(resolved, archiveEntry);
      zipTempDir = extracted.tempDir; resolved = extracted.discPath;
    }
    const isVcd = /\.vcd$/i.test(resolved);
    const preflight = isVcd ? { bytes: (await validateVcd(resolved)).bytes, sourceBytes: 0, sheet: undefined } : await inspectCue(resolved);
    await requireSpace(popsDir, preflight.bytes * 2 + (preflight.sheet && preflight.sheet.files.length > 1 ? preflight.sourceBytes : 0));
    let gameId = overrideGameId?.trim().toUpperCase() || "";
    if (gameId && !/^[A-Z]{4}_\d{3}\.\d{2}$/.test(gameId)) throw new Error("Game ID must use SLUS_123.45 format, or be left blank.");
    onProgress?.(10, "Detecting PS1 game ID");
    const id = isVcd ? await tryDeterminePs1GameIdFromVcd(resolved) : await tryDeterminePs1GameIdFromHex(resolved);
    if (!gameId && id.success && "gameId" in id) gameId = id.gameId || "";
    if (!gameId && launcherMode !== "psxcore") gameId = await generateHomebrewGameId(popsDir);
    const sourceStem = path.basename(resolved, path.extname(resolved));
    const sourceTitle = sourceStem.replace(/^[A-Z]{4}_\d{3}\.\d{2}\./i, "");
    let gameName = overrideGameName?.trim() || (id.success && "gameName" in id ? id.gameName : "") || sourceTitle;
    const identity = archiveEntry || sourceStem;
    const disc = identity.match(/(?:disc|disk|cd)[ _.-]*(\d+)/i);
    if (disc && !new RegExp('(?:disc|disk|cd)[ _.-]*' + disc[1] + '(?:\\D|$)', 'i').test(gameName)) gameName += ' (Disc ' + disc[1] + ')';
    if (archiveEntry && !disc && path.dirname(archiveEntry) !== "." && gameName === sourceStem)
      gameName += ' (' + path.basename(path.dirname(archiveEntry)) + ')';
    const sanitizedName = sanitizeGameFilename(gameName).replace(/\x7f/g, "");
    const stem = launcherMode === "popsloader" || !gameId ? sanitizedName : gameId + '.' + sanitizedName;
    const vcdPath = launcherMode === "psxcore" ? await uniqueVcdPath(popsDir, stem) : path.join(popsDir, stem + '.VCD');
    await assertAbsent(vcdPath);
    let elf: string | null = null, appsGameDir: string | undefined, elfFilename: string | undefined;
    if (launcherMode === "popstarter") {
      if (!["XX.", "SB.", ""].includes(elfPrefix)) throw new Error("Invalid POPStarter device prefix.");
      elf = await findPopstarterElf();
      if (!elf) throw new Error("POPSTARTER.ELF not found in assets.");
      await ensureChildDirectory(oplRoot, "APPS");
      appsGameDir = path.join(oplRoot, "APPS", 'POPS_' + sanitizedName);
      await assertAbsent(appsGameDir);
      elfFilename = elfPrefix + stem + '.ELF';
    }
    workDir = await fs.mkdtemp(path.join(popsDir, ".luna-import-"));
    const tempVcd = path.join(workDir, "disc.VCD");
    if (isVcd) {
      onProgress?.(35, "Copying existing VCD");
      const before = await fs.stat(resolved);
      await fs.copyFile(resolved, tempVcd, constants.COPYFILE_EXCL);
      const after = await fs.stat(resolved);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Source VCD changed during import.");
      const staged = await fs.open(tempVcd, "r+");
      try { await staged.sync(); } finally { await staged.close(); }
    } else {
      let bin: string, cue = resolved;
      if (preflight.sheet!.files.length > 1) {
        const merged = await mergeMultiBin(resolved, workDir, (p, stage) => onProgress?.(15 + Math.round(p * 0.2), stage));
        bin = merged.mergedBinPath; cue = merged.mergedCuePath;
      } else bin = await resolveCueBin(cue, preflight.sheet!.files[0].filename);
      await convertToVcd(bin, cue, tempVcd, (p, stage) => onProgress?.(35 + Math.round(p * 0.5), stage));
    }
    await validateVcd(tempVcd);
    onProgress?.(86, "Installing validated VCD");
    if (appsGameDir && elf && elfFilename) {
      await fs.mkdir(appsGameDir);
      try {
        await fs.copyFile(elf, path.join(appsGameDir, elfFilename), constants.COPYFILE_EXCL);
        await fs.writeFile(path.join(appsGameDir, "title.cfg"), 'title=' + gameName.replace(/[\r\n]/g, ' ') + '\nboot=' + elfFilename + '\nGameID=' + gameId + '\n', { flag: "wx" });
        await publishFile(tempVcd, vcdPath, validateVcd);
      } catch (error) { await fs.rm(appsGameDir, { recursive: true, force: true }); throw error; }
    } else await publishFile(tempVcd, vcdPath, validateVcd);
    if (downloadArtwork && gameId) {
      try {
        await ensureChildDirectory(oplRoot, "ART");
        const artName = launcherMode === "psxcore" ? gameId : launcherMode === "popsloader" ? sanitizedName : elfFilename;
        await downloadArtByGameId(artDir, gameId, "PS1", artName, launcherMode === "psxcore" ? ["COV", "PSBBN"] : ["COV"], true);
      } catch { /* Artwork availability does not invalidate the installed disc. */ }
    }
    const message = launcherMode === "psxcore" ? (isVcd ? "Validated and installed" : "Converted and installed") + "; console launch requires LUNA discovery and PSXCore handoff integration." : "Import complete";
    onProgress?.(100, message);
    return { success: true, vcdPath, gameId, gameName, message,
      ...(launcherMode === "psxcore" ? { readyToLaunch: false } : {}) };
  } catch (err: any) {
    log.error('PS1 import failed:', err?.message || err);
    return { success: false, message: describeFileAccessError(err) };
  } finally {
    for (const dir of [workDir, zipTempDir]) if (dir) await fs.rm(dir, { recursive: true, force: true })
      .catch(error => log.warn(`Could not clean owned import staging ${dir}: ${error.message}`));
  }
}
