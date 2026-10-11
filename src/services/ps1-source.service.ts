import * as fs from "fs/promises";
import path from "path";
import { parseCueSheet, resolveCueBin, msfToSectors } from "../utils/cue-parser";
import { listZipDiscs } from "../utils/zip-extract";
import { validateVcd, VCD_HEADER_BYTES } from "../utils/psxcore-vcd";

export async function resolvePs1Source(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".bin") {
    const dir = path.dirname(file), matched: string[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!/\.cue$/i.test(name)) continue;
      const cue = path.join(dir, name);
      try {
        const sheet = await parseCueSheet(cue);
        for (const f of sheet.files) {
          if ((await resolveCueBin(cue, f.filename)).toLowerCase() === file.toLowerCase()) { matched.push(cue); break; }
        }
      } catch { /* An unrelated malformed CUE is not a match. */ }
    }
    if (matched.length !== 1) throw new Error(matched.length ?
      "Several CUE sheets reference this BIN. Select the intended CUE." :
      "No matching CUE found. Select the original CUE alongside all BIN tracks: track types, indexes and audio gaps are required for VCD conversion.");
    return matched[0];
  }
  if (![".cue", ".vcd", ".zip"].includes(ext)) throw new Error("Select a CUE, BIN with matching CUE, ZIP, or existing VCD.");
  return file;
}

export async function inspectPs1Source(file: string) {
  const resolved = await resolvePs1Source(file);
  if (/\.zip$/i.test(resolved)) {
    const discs = listZipDiscs(resolved);
    if (!discs.length) throw new Error("ZIP contains no CUE or VCD disc images. BIN tracks need their CUE sheet.");
    return { path: resolved, discs };
  }
  if (/\.vcd$/i.test(resolved)) await validateVcd(resolved);
  else await inspectCue(resolved);
  return { path: resolved, discs: [] as string[] };
}

/** Preflight BEFORE merging, so unsupported FILE/sector formats cannot be
 * masked by the generated BINARY CUE. Embedded INDEX 00 bytes remain intact. */
export async function inspectCue(cuePath: string) {
  const sheet = await parseCueSheet(cuePath);
  let bytes = VCD_HEADER_BYTES, sourceBytes = 0, number = 1;
  for (const f of sheet.files) {
    if (f.filetype !== "BINARY") throw new Error(`Unsupported CUE FILE type ${f.filetype}. Supply BINARY raw BIN tracks.`);
    const bin = await resolveCueBin(cuePath, f.filename), stat = await fs.stat(bin);
    if (!stat.size || stat.size % 2352) throw new Error(`Track ${f.filename} is not aligned to raw 2352-byte sectors.`);
    sourceBytes += stat.size; bytes += stat.size;
    let previous = -1;
    for (const t of f.tracks) {
      if (!["MODE1/2352", "MODE2/2352", "AUDIO"].includes(t.type))
        throw new Error(`Unsupported sector format ${t.type}; PS1 VCD conversion requires raw 2352-byte data/audio tracks.`);
      const one = t.indexes.find(x => x.number === 1), zero = t.indexes.find(x => x.number === 0);
      if (t.number !== number++ || !one || t.indexes.some(x => x.number > 1) ||
          new Set(t.indexes.map(x => x.number)).size !== t.indexes.length ||
          (t.pregap && zero)) throw new Error("Invalid CUE track numbering/indexes or ambiguous PREGAP with INDEX 00.");
      const at = msfToSectors(one.minutes, one.seconds, one.frames);
      const z = zero ? msfToSectors(zero.minutes, zero.seconds, zero.frames) : at;
      if (at <= previous || at * 2352 >= stat.size || z > at || z <= previous)
        throw new Error("CUE index lies outside its BIN or overlaps the previous track.");
      previous = at;
      for (const gap of [t.pregap, t.postgap]) if (gap) bytes += msfToSectors(gap.minutes, gap.seconds, gap.frames) * 2352;
    }
  }
  if (number > 100 || sheet.files[0].tracks[0].type === "AUDIO") throw new Error("PSXCore requires a data track first and at most 99 tracks.");
  if (bytes > 0x7fffffff) throw new Error("VCD exceeds PSXCore's 2 GiB minus 1 byte runtime limit.");
  return { sheet, bytes, sourceBytes };
}
