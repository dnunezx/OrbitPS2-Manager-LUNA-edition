import * as fs from "fs/promises";
import path from "path";
import { createLogger } from "../logger";

const log = createLogger("cue-parser");

export interface CueIndex {
  number: number; // 0 or 1
  minutes: number;
  seconds: number;
  frames: number;
}

export interface CueTrack {
  number: number;
  type: string; // e.g., "MODE2/2352", "AUDIO"
  indexes: CueIndex[];
  pregap?: { minutes: number; seconds: number; frames: number };
  postgap?: { minutes: number; seconds: number; frames: number };
}

export interface CueFile {
  filename: string;
  filetype: string; // e.g., "BINARY"
  tracks: CueTrack[];
}

export interface CueSheet {
  files: CueFile[];
}

function parseMsf(msfStr: string): {
  minutes: number;
  seconds: number;
  frames: number;
} {
  const parts = msfStr.split(":");
  if (!/^\d{1,3}:\d{2}:\d{2}$/.test(msfStr) || Number(parts[1]) >= 60 || Number(parts[2]) >= 75) {
    throw new Error(`Invalid CUE timestamp: ${msfStr}`);
  }
  return {
    minutes: parseInt(parts[0], 10),
    seconds: parseInt(parts[1], 10),
    frames: parseInt(parts[2], 10),
  };
}

export function msfToSectors(
  minutes: number,
  seconds: number,
  frames: number
): number {
  return minutes * 60 * 75 + seconds * 75 + frames;
}

export function sectorsToMsf(sectors: number): {
  minutes: number;
  seconds: number;
  frames: number;
} {
  const minutes = Math.floor(sectors / 4500);
  const seconds = Math.floor((sectors % 4500) / 75);
  const frames = sectors % 75;
  return { minutes, seconds, frames };
}

export async function parseCueSheet(cueFilePath: string): Promise<CueSheet> {
  const content = await fs.readFile(cueFilePath, "utf-8");
  const lines = content.split(/\r?\n/);

  const cueSheet: CueSheet = { files: [] };
  let currentFile: CueFile | null = null;
  let currentTrack: CueTrack | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^(FILE|TRACK|INDEX|PREGAP|POSTGAP)\b/i, x => x.toUpperCase());
    if (!line) continue;

    if (line.startsWith("FILE ")) {
      // FILE "filename.bin" BINARY
      const match = line.match(/^FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)$/);
      if (!match) throw new Error(`Malformed CUE FILE: ${line}`);

      if (currentTrack && currentFile) {
        currentFile.tracks.push(currentTrack);
        currentTrack = null;
      }

      currentFile = {
        filename: match[1] || match[2],
        filetype: match[3].toUpperCase(),
        tracks: [],
      };
      cueSheet.files.push(currentFile);
    } else if (line.startsWith("TRACK ")) {
      // TRACK 01 MODE2/2352
      const match = line.match(/^TRACK\s+(\d+)\s+(.+)/);
      if (!match || !currentFile) throw new Error(`Malformed CUE TRACK: ${line}`);

      if (currentTrack) {
        currentFile.tracks.push(currentTrack);
      }

      currentTrack = {
        number: parseInt(match[1], 10),
        type: match[2].trim().toUpperCase(),
        indexes: [],
      };
    } else if (line.startsWith("INDEX ")) {
      // INDEX 01 00:00:00
      const match = line.match(/^INDEX\s+(\d+)\s+(\d+:\d+:\d+)/);
      if (!match || !currentTrack) throw new Error(`Malformed CUE INDEX: ${line}`);

      const msf = parseMsf(match[2]);
      currentTrack.indexes.push({
        number: parseInt(match[1], 10),
        ...msf,
      });
    } else if (line.startsWith("PREGAP ")) {
      const match = line.match(/^PREGAP\s+(\d+:\d+:\d+)/);
      if (!match || !currentTrack || currentTrack.pregap) throw new Error(`Malformed CUE PREGAP: ${line}`);
      currentTrack.pregap = parseMsf(match[1]);
    } else if (line.startsWith("POSTGAP ")) {
      const match = line.match(/^POSTGAP\s+(\d+:\d+:\d+)/);
      if (!match || !currentTrack || currentTrack.postgap) throw new Error(`Malformed CUE POSTGAP: ${line}`);
      currentTrack.postgap = parseMsf(match[1]);
    }
    // REM and other directives are ignored
  }

  // Push the last track
  if (currentTrack && currentFile) {
    currentFile.tracks.push(currentTrack);
  }

  const trackTotal = cueSheet.files.reduce((n, f) => n + f.tracks.length, 0);
  if (!trackTotal || cueSheet.files.some(f => !f.tracks.length)) throw new Error("CUE contains no usable tracks.");
  log.verbose(
    `Parsed ${path.basename(cueFilePath)}: ${cueSheet.files.length} FILE(s), ${trackTotal} track(s)`
  );
  return cueSheet;
}

export function getBlockSize(trackType: string): number {
  if (trackType.startsWith("MODE1/2048")) return 2048;
  if (trackType.startsWith("MODE1/2352")) return 2352;
  if (trackType.startsWith("MODE2/2352")) return 2352;
  if (trackType === "AUDIO") return 2352;
  return 2352; // default
}

export function getCueDirectory(cueFilePath: string): string {
  return path.dirname(cueFilePath);
}

/** Resolve portable CUE separators, rejecting absolute paths and traversal. */
export async function resolveCueBin(cuePath: string, filename: string): Promise<string> {
  const relative = filename.replace(/\\/g, "/");
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split("/").some(p => !p || p === ".." || p === "."))
    throw new Error(`CUE track must be inside its source folder: ${filename}`);
  let result = path.dirname(cuePath);
  for (const part of relative.split("/")) {
    const entries = await fs.readdir(result);
    const matches = entries.filter(n => n.toLowerCase() === part.toLowerCase());
    if (matches.length !== 1) throw new Error(`Missing or ambiguous CUE track: ${filename}`);
    result = path.join(result, matches[0]);
    const stat = await fs.lstat(result);
    if (stat.isSymbolicLink()) throw new Error(`CUE track cannot be a symbolic link: ${filename}`);
  }
  if (!(await fs.stat(result)).isFile()) throw new Error(`CUE track is not a file: ${filename}`);
  return result;
}
