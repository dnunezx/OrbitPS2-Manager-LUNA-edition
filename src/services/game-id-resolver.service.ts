import * as fs from "fs/promises";
import path from "path";
import { getCachedGameId, setCachedGameId } from "./iso-cache.service";
import { createLogger, formatBytes } from "../logger";
import { resolveCueBin } from "../utils/cue-parser";
import { describeFileAccessError } from "../utils/file-access-error";
import {
  PS1_GAME_ID_REGEX,
  PS2_GAME_ID_REGEX,
  FILE_SCAN_CHUNK_BYTES,
  FILE_SCAN_OVERLAP_BYTES,
  VCD_HEADER_SIZE,
  normaliseGameIdForLookup,
} from "../utils/game-id-patterns";
import { findPs1GameName, findPs2GameName } from "../utils/games-list";
import { parseCueSheet, getCueDirectory } from "../utils/cue-parser";
import { streamZsoContents } from "./zso.service";
import { extractDiscZip, cleanupExtractedZip } from "../utils/zip-extract";

const log = createLogger("game-id");

/**
 * Resolves the PS2 game ID for an ISO that doesn't carry the GAMEID prefix
 * in its filename (the "new" OPL naming convention — OPL reads the ID from
 * the disc's SYSTEM.CNF). Results are cached per (path, size, mtime) so
 * library scans only pay the hex-scan cost the first time.
 */
export async function resolveIsoGameId(
  filepath: string
): Promise<{
  success: boolean;
  gameId?: string;
  gameName?: string;
  message?: string;
}> {
  let stat;
  try {
    stat = await fs.stat(filepath);
  } catch (err: any) {
    log.error(`Cannot stat ${filepath} for ID resolution:`, err?.message || err);
    return { success: false, message: describeFileAccessError(err, filepath) };
  }

  const cached = getCachedGameId(filepath, stat.size, stat.mtimeMs);
  if (cached) {
    log.verbose(`Resolved ${path.basename(filepath)} from cache → ${cached.gameId}`);
    return { success: true, gameId: cached.gameId, gameName: cached.gameName };
  }

  const isZso = path.extname(filepath).toLowerCase() === ".zso";
  log.verbose(
    `Cache miss for ${path.basename(filepath)} (${formatBytes(stat.size)}) — ` +
      `scanning ${isZso ? "decompressed ZSO" : "raw image"} for game ID`
  );
  const result = isZso
    ? await tryDetermineGameIdFromZso(filepath)
    : await tryDetermineGameIdFromHex(filepath);
  if (result && (result as any).success) {
    const r = result as any;
    setCachedGameId(filepath, stat.size, stat.mtimeMs, r.gameId, r.gameName);
    const titleSuffix = r.gameName ? ` (${r.gameName})` : "";
    log.info(`Resolved ${path.basename(filepath)} → ${r.gameId}${titleSuffix}`);
    return { success: true, gameId: r.gameId, gameName: r.gameName };
  }
  log.warn(`Could not resolve a game ID for ${path.basename(filepath)}`);
  return {
    success: false,
    message: (result as any)?.message || "Could not resolve game ID.",
  };
}

export async function tryDetermineGameIdFromHex(filepath: string) {
  let scanPath = filepath;

  if (path.extname(filepath).toLowerCase() === ".cue") {
    try {
      const cueSheet = await parseCueSheet(filepath);
      const firstFile = cueSheet.files[0]?.filename;
      if (!firstFile) {
        return {
          success: false,
          message: "CUE sheet does not reference any BIN files.",
        };
      }
      scanPath = path.join(getCueDirectory(filepath), firstFile);
      log.verbose(`PS2 hex scan: resolved CUE to first BIN ${firstFile}`);
    } catch (err: any) {
      log.error(`PS2 hex scan: failed to parse CUE ${filepath}:`, err?.message || err);
      return {
        success: false,
        message: err?.message || "Failed to parse CUE sheet.",
      };
    }
  }

  let fileHandle: fs.FileHandle | undefined;

  try {
    fileHandle = await fs.open(scanPath, "r");
  } catch (err: any) {
    log.error(`PS2 hex scan: cannot open ${scanPath}:`, err?.code || err?.message || err);
    return {
      success: false,
      message: describeFileAccessError(err, scanPath),
    };
  }

  try {
    log.verbose(`PS2 hex scan: reading ${path.basename(scanPath)} in ${FILE_SCAN_CHUNK_BYTES / 1024}KB chunks`);
    const buffer = Buffer.alloc(FILE_SCAN_CHUNK_BYTES);
    let position = 0;
    let carry = "";

    while (true) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        FILE_SCAN_CHUNK_BYTES,
        position
      );

      if (bytesRead === 0) {
        break;
      }

      position += bytesRead;

      const chunk = carry + buffer.subarray(0, bytesRead).toString("latin1");
      PS2_GAME_ID_REGEX.lastIndex = 0;
      const matches = chunk.match(PS2_GAME_ID_REGEX);

      if (matches && matches.length > 0) {
        const gameId = matches[0].replace(/;1$/, "");
        const lookupId = normaliseGameIdForLookup(gameId);
        const gameName = await findPs2GameName(lookupId);

        log.verbose(
          `PS2 hex scan: matched ${gameId} within first ${formatBytes(position)}` +
            (gameName ? ` (${gameName})` : " (no title in games list)")
        );
        return {
          success: true,
          gameId,
          formattedGameId: lookupId,
          ...(gameName ? { gameName } : {}),
        };
      }

      carry =
        chunk.length > FILE_SCAN_OVERLAP_BYTES
          ? chunk.slice(-FILE_SCAN_OVERLAP_BYTES)
          : chunk;
    }

    log.verbose(`PS2 hex scan: no game ID found after reading ${formatBytes(position)}`);
    return {
      success: false,
      message: "Could not locate a PS2 game ID inside the provided file.",
    };
  } catch (err: any) {
    log.error(`PS2 hex scan: read error on ${path.basename(scanPath)}:`, err?.message || err);
    return {
      success: false,
      message: err?.message || "Failed while reading file contents.",
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function tryDetermineGameIdFromZso(filepath: string) {
  const SCAN_FLUSH_BYTES = FILE_SCAN_CHUNK_BYTES;
  const SCAN_LIMIT_BYTES = 64 * 1024 * 1024;
  let pending = "";
  let foundId: string | null = null;

  const scan = (text: string): boolean => {
    PS2_GAME_ID_REGEX.lastIndex = 0;
    const matches = text.match(PS2_GAME_ID_REGEX);
    if (matches && matches.length > 0) {
      foundId = matches[0].replace(/;1$/, "");
      return true;
    }
    return false;
  };

  const result = await streamZsoContents(
    filepath,
    (chunk) => {
      pending += chunk.toString("latin1");
      if (pending.length < SCAN_FLUSH_BYTES) {
        return false;
      }
      if (scan(pending)) {
        return true;
      }
      pending = pending.slice(-FILE_SCAN_OVERLAP_BYTES);
      return false;
    },
    SCAN_LIMIT_BYTES
  );

  if (!foundId && pending) {
    scan(pending);
  }

  if (foundId) {
    const lookupId = normaliseGameIdForLookup(foundId);
    const gameName = await findPs2GameName(lookupId);
    log.verbose(
      `ZSO scan: matched ${foundId}` +
        (gameName ? ` (${gameName})` : " (no title in games list)")
    );
    return {
      success: true,
      gameId: foundId,
      formattedGameId: lookupId,
      ...(gameName ? { gameName } : {}),
    };
  }

  if (!result.success) {
    log.error(`ZSO scan: failed to read ${path.basename(filepath)}: ${result.message}`);
    return {
      success: false,
      message: result.message || "Failed while reading ZSO contents.",
    };
  }

  log.verbose(`ZSO scan: no game ID found in ${path.basename(filepath)}`);
  return {
    success: false,
    message: "Could not locate a PS2 game ID inside the ZSO image.",
  };
}

export async function tryDeterminePs1GameIdFromVcd(
  filepath: string
): Promise<{
  success: boolean;
  gameId?: string;
  formattedGameId?: string;
  gameName?: string;
  message?: string;
}> {
  let fileHandle: fs.FileHandle | undefined;

  try {
    fileHandle = await fs.open(filepath, "r");
  } catch (err: any) {
    log.error(`PS1 VCD scan: cannot open ${filepath}:`, err?.code || err?.message || err);
    return {
      success: false,
      message: describeFileAccessError(err, filepath),
    };
  }

  try {
    log.verbose(`PS1 VCD scan: reading ${path.basename(filepath)} from offset 1 MB (VCD header skip)`);
    const buffer = Buffer.alloc(FILE_SCAN_CHUNK_BYTES);
    let position = VCD_HEADER_SIZE;
    let carry = "";
    const fileSize = (await fs.stat(filepath)).size;

    while (position < fileSize) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        FILE_SCAN_CHUNK_BYTES,
        position
      );

      if (bytesRead === 0) {
        break;
      }

      position += bytesRead;

      const chunk = carry + buffer.subarray(0, bytesRead).toString("latin1");
      PS1_GAME_ID_REGEX.lastIndex = 0;
      const matches = chunk.match(PS1_GAME_ID_REGEX);

      if (matches && matches.length > 0) {
        const rawId = matches[0];
        const gameId = rawId.replace("-", "_");
        const lookupId = normaliseGameIdForLookup(gameId);
        const gameName = await findPs1GameName(lookupId);

        log.verbose(
          `PS1 VCD scan: matched ${gameId} at offset ${position - bytesRead}` +
            (gameName ? ` (${gameName})` : " (no title in games list)")
        );
        return {
          success: true,
          gameId,
          formattedGameId: lookupId,
          ...(gameName ? { gameName } : {}),
        };
      }

      carry =
        chunk.length > FILE_SCAN_OVERLAP_BYTES
          ? chunk.slice(-FILE_SCAN_OVERLAP_BYTES)
          : chunk;

      if (position - VCD_HEADER_SIZE > 64 * 1024 * 1024) {
        log.verbose(`PS1 VCD scan: hit 64 MB safety bound for ${path.basename(filepath)}`);
        break;
      }
    }

    log.verbose(`PS1 VCD scan: no game ID found in ${path.basename(filepath)}`);
    return {
      success: false,
      message: "Could not locate a PS1 game ID inside the VCD disc data.",
    };
  } catch (err: any) {
    log.error(`PS1 VCD scan: read error on ${path.basename(filepath)}:`, err?.message || err);
    return {
      success: false,
      message: err?.message || "Failed while reading VCD file contents.",
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function tryDeterminePs1GameIdFromHex(filepath: string) {
  let scanPath = filepath;
  let zipTempDir: string | null = null;

  try {
    if (path.extname(filepath).toLowerCase() === ".zip") {
      let extracted;
      try {
        extracted = await extractDiscZip(filepath);
      } catch (err: any) {
        log.error(`PS1 hex scan: failed to extract ZIP ${filepath}:`, err?.message || err);
        return {
          success: false,
          message: err?.message || "Failed to extract ZIP archive.",
        };
      }
      zipTempDir = extracted.tempDir;
      if (!extracted.cuePath && !extracted.binPath) {
        return {
          success: false,
          message: "ZIP archive does not contain a .cue or .bin file.",
        };
      }
      scanPath = extracted.cuePath || (extracted.binPath as string);
    }

    if (path.extname(scanPath).toLowerCase() === ".cue") {
      try {
        const cueSheet = await parseCueSheet(scanPath);
        const firstFile = cueSheet.files[0]?.filename;
        if (!firstFile) {
          return {
            success: false,
            message: "CUE sheet does not reference any BIN files.",
          };
        }
        scanPath = await resolveCueBin(scanPath, firstFile);
        log.verbose(`PS1 hex scan: resolved CUE to first BIN ${firstFile}`);
      } catch (err: any) {
        log.error(`PS1 hex scan: failed to parse CUE ${scanPath}:`, err?.message || err);
        return {
          success: false,
          message: err?.message || "Failed to parse CUE sheet.",
        };
      }
    }

    let fileHandle: fs.FileHandle | undefined;

    try {
      fileHandle = await fs.open(scanPath, "r");
    } catch (err: any) {
      log.error(`PS1 hex scan: cannot open ${scanPath}:`, err?.code || err?.message || err);
      return {
        success: false,
        message: describeFileAccessError(err, scanPath),
      };
    }

    try {
      log.verbose(`PS1 hex scan: reading ${path.basename(scanPath)} in ${FILE_SCAN_CHUNK_BYTES / 1024}KB chunks`);
      const buffer = Buffer.alloc(FILE_SCAN_CHUNK_BYTES);
      let position = 0;
      let carry = "";

      while (true) {
        const { bytesRead } = await fileHandle.read(
          buffer,
          0,
          FILE_SCAN_CHUNK_BYTES,
          position
        );

        if (bytesRead === 0) {
          break;
        }

        position += bytesRead;

        const chunk = carry + buffer.subarray(0, bytesRead).toString("latin1");
        PS1_GAME_ID_REGEX.lastIndex = 0;
        const matches = chunk.match(PS1_GAME_ID_REGEX);

        if (matches && matches.length > 0) {
          const rawId = matches[0];
          const gameId = rawId.replace("-", "_");
          const lookupId = normaliseGameIdForLookup(gameId);
          const gameName = await findPs1GameName(lookupId);

          log.verbose(
            `PS1 hex scan: matched ${gameId} within first ${formatBytes(position)}` +
              (gameName ? ` (${gameName})` : " (no title in games list)")
          );
          return {
            success: true,
            gameId,
            formattedGameId: lookupId,
            ...(gameName ? { gameName } : {}),
          };
        }

        carry =
          chunk.length > FILE_SCAN_OVERLAP_BYTES
            ? chunk.slice(-FILE_SCAN_OVERLAP_BYTES)
            : chunk;
      }

      log.verbose(`PS1 hex scan: no game ID found after reading ${formatBytes(position)}`);
      return {
        success: false,
        message: "Could not locate a PS1 game ID inside the provided file.",
      };
    } catch (err: any) {
      log.error(`PS1 hex scan: read error on ${path.basename(scanPath)}:`, err?.message || err);
      return {
        success: false,
        message: err?.message || "Failed while reading file contents.",
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  } finally {
    if (zipTempDir) {
      await cleanupExtractedZip(zipTempDir);
    }
  }
}
