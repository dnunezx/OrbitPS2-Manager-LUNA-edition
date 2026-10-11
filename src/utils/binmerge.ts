import * as fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
  parseCueSheet,
  getBlockSize,
  msfToSectors,
  sectorsToMsf,
  CueSheet,
  resolveCueBin,
} from "./cue-parser";
import { createLogger, formatBytes } from "../logger";

const log = createLogger("binmerge");

export interface MergeResult {
  mergedBinPath: string;
  mergedCuePath: string;
  cueSheet: CueSheet;
}

export async function mergeMultiBin(
  cueFilePath: string,
  outputDir: string,
  onProgress?: (percent: number, stage: string) => void
): Promise<MergeResult> {
  const cueSheet = await parseCueSheet(cueFilePath);

  // Single-file CUE: no merge needed
  if (cueSheet.files.length <= 1) {
    log.verbose("Single-file CUE — no BIN merge needed");
    const binPath = await resolveCueBin(cueFilePath, cueSheet.files[0].filename);
    return {
      mergedBinPath: binPath,
      mergedCuePath: cueFilePath,
      cueSheet,
    };
  }

  // Determine block size from first track
  const firstTrackType = cueSheet.files[0].tracks[0]?.type || "MODE2/2352";
  const blockSize = getBlockSize(firstTrackType);
  log.info(`Merging ${cueSheet.files.length} BIN files (block size ${blockSize}B)`);

  const baseName = path.parse(cueFilePath).name;
  const mergedBinPath = path.join(outputDir, `${baseName}.bin`);
  const mergedCuePath = path.join(outputDir, `${baseName}.cue`);

  // Preflight all source files and offsets before opening any output.
  let cumulativeOffset = 0, totalSize = 0, writtenBytes = 0;
  const fileOffsets: number[] = [], bins: string[] = [];
  for (const file of cueSheet.files) {
    const bin = await resolveCueBin(cueFilePath, file.filename);
    const size = (await fs.stat(bin)).size;
    if (!size || size % blockSize) throw new Error("BIN payload is not sector aligned.");
    if (file.tracks.some(t => getBlockSize(t.type) !== blockSize)) throw new Error("Mixed sector sizes cannot be merged.");
    fileOffsets.push(cumulativeOffset); cumulativeOffset += size / blockSize;
    totalSize += size; bins.push(bin);
  }
  async function* chunks() {
    for (let i = 0; i < bins.length; i++) {
      for await (const chunk of fsSync.createReadStream(bins[i])) {
        writtenBytes += chunk.length;
        onProgress?.(Math.round(writtenBytes / totalSize * 100), "Merging BIN tracks");
        yield chunk;
      }
    }
    if (writtenBytes !== totalSize) throw new Error("BIN changed during merge.");
  }
  const output = await fs.open(mergedBinPath, "wx");
  try {
    await pipeline(Readable.from(chunks()), fsSync.createWriteStream(mergedBinPath, { fd: output.fd, autoClose: false }));
    await output.sync();
  } catch (error) {
    await output.close().catch(() => {}); await fs.unlink(mergedBinPath).catch(() => {}); throw error;
  }
  await output.close();

  // Build merged CUE with recalculated offsets
  const mergedCueSheet: CueSheet = {
    files: [
      {
        filename: path.basename(mergedBinPath),
        filetype: "BINARY",
        tracks: [],
      },
    ],
  };

  for (let i = 0; i < cueSheet.files.length; i++) {
    const file = cueSheet.files[i];
    const offsetSectors = fileOffsets[i];

    for (const track of file.tracks) {
      const newTrack = { ...track, indexes: [...track.indexes] };
      newTrack.indexes = track.indexes.map((idx) => {
        const originalSectors = msfToSectors(
          idx.minutes,
          idx.seconds,
          idx.frames
        );
        const newSectors = originalSectors + offsetSectors;
        const msf = sectorsToMsf(newSectors);
        return { number: idx.number, ...msf };
      });
      mergedCueSheet.files[0].tracks.push(newTrack);
    }
  }

  // Write the new CUE file
  let cueContent = `FILE "${path.basename(mergedBinPath)}" BINARY\r\n`;
  for (const track of mergedCueSheet.files[0].tracks) {
    cueContent += `  TRACK ${String(track.number).padStart(2, "0")} ${track.type}\r\n`;
    if (track.pregap) {
      cueContent += `    PREGAP ${formatMsf(track.pregap.minutes, track.pregap.seconds, track.pregap.frames)}\r\n`;
    }
    for (const idx of track.indexes) {
      cueContent += `    INDEX ${String(idx.number).padStart(2, "0")} ${formatMsf(idx.minutes, idx.seconds, idx.frames)}\r\n`;
    }
    if (track.postgap) {
      cueContent += `    POSTGAP ${formatMsf(track.postgap.minutes, track.postgap.seconds, track.postgap.frames)}\r\n`;
    }
  }

  try { await fs.writeFile(mergedCuePath, cueContent, { encoding: "utf-8", flag: "wx" }); }
  catch (error) { await fs.unlink(mergedBinPath).catch(() => {}); throw error; }

  log.info(
    `Merged ${cueSheet.files.length} BIN files → ${path.basename(mergedBinPath)} ` +
      `(${formatBytes(writtenBytes)}, ${mergedCueSheet.files[0].tracks.length} track(s))`
  );

  return {
    mergedBinPath,
    mergedCuePath,
    cueSheet: mergedCueSheet,
  };
}

function formatMsf(
  minutes: number,
  seconds: number,
  frames: number
): string {
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}
