import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { parseCueSheet, msfToSectors, CueTrack } from "./cue-parser";
import { checkVcdHeader, validateVcd, VCD_HEADER_BYTES, VCD_SECTOR_BYTES } from "./psxcore-vcd";

const sectors = (v: { minutes: number; seconds: number; frames: number }) =>
  msfToSectors(v.minutes, v.seconds, v.frames);
const bcd = (n: number) => Math.floor(n / 10) * 16 + n % 10;
function stamp(h: Buffer, o: number, n: number) {
  h[o] = bcd(Math.floor(n / 4500)); h[o + 1] = bcd(Math.floor(n % 4500 / 75)); h[o + 2] = bcd(n % 75);
}
interface Gap { at: number; length: number }

export async function planVcd(binPath: string, cuePath: string) {
  const cue = await parseCueSheet(cuePath);
  if (cue.files.length !== 1) throw new Error("Merge multi-BIN CUEs before VCD conversion.");
  const tracks = cue.files[0].tracks;
  if (cue.files[0].filetype !== "BINARY" || !tracks.length || tracks.length > 99)
    throw new Error("VCD conversion requires 1–99 BINARY tracks.");
  if (!tracks[0].type.startsWith("MODE")) throw new Error("PSXCore requires a data track first.");
  const sourceStat = await fs.stat(binPath), size = sourceStat.size;
  if (!size || size % VCD_SECTOR_BYTES) throw new Error("BIN length must be a nonzero multiple of 2352 bytes.");
  const sourceSectors = size / VCD_SECTOR_BYTES;
  const gaps: Gap[] = [];
  const starts: number[] = [], zeros: Array<number | undefined> = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!["MODE1/2352", "MODE2/2352", "AUDIO"].includes(t.type))
      throw new Error(`Unsupported sector format ${t.type}. Supply raw 2352-byte BIN/CUE tracks; cooked 2048/2336-byte, WAVE and subchannel images are unsupported.`);
    const one = t.indexes.find(x => x.number === 1), zero = t.indexes.find(x => x.number === 0);
    if (t.number !== i + 1 || !one || t.indexes.some(x => x.number > 1) ||
        new Set(t.indexes.map(x => x.number)).size !== t.indexes.length)
      throw new Error("CUE tracks must be consecutive from 01 with one INDEX 01 and optional INDEX 00.");
    const start = sectors(one), z = zero ? sectors(zero) : undefined;
    if (start >= sourceSectors || (i && start <= starts[i - 1]) ||
        (z !== undefined && (z > start || (i > 0 && z <= starts[i - 1]))) ||
        (t.pregap && zero)) throw new Error("Invalid or ambiguous CUE indexes/PREGAP. INDEX 00 is already stored in the BIN.");
    starts.push(start); zeros.push(z);
    if (t.pregap) gaps.push({ at: start, length: sectors(t.pregap) });
  }
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].postgap) gaps.push({ at: i + 1 < tracks.length ? zeros[i + 1] ?? starts[i + 1] : sourceSectors,
      length: sectors(tracks[i].postgap!) });
  }
  gaps.sort((a, b) => a.at - b.at);
  const count = sourceSectors + gaps.reduce((n, g) => n + g.length, 0);
  const header = Buffer.alloc(VCD_HEADER_BYTES);
  header[0] = 0x41; header[2] = 0xa0; header[7] = 1; header[8] = 0x20;
  const type = (t: CueTrack) => t.type === "AUDIO" ? 1 : 0x41;
  header[10] = header[20] = type(tracks[tracks.length - 1]); header[12] = 0xa1;
  header[17] = bcd(tracks.length); header[22] = 0xa2;
  header[26] = bcd(Math.floor((count + 150) / 450000));
  stamp(header, 27, (count + 150) % 450000);
  for (let i = 0; i < tracks.length; i++) {
    const o = 30 + i * 10;
    const shift = (at: number) => gaps.filter(g => g.at <= at).reduce((n, g) => n + g.length, 0);
    const start = starts[i] + shift(starts[i]) + 150;
    // INDEX 00 is embedded in the source; synthetic PREGAP precedes INDEX 01.
    const z = zeros[i] !== undefined ? zeros[i]! + shift(zeros[i]!) + 150 :
      start - (tracks[i].pregap ? sectors(tracks[i].pregap!) : 0);
    header[o] = type(tracks[i]); header[o + 2] = bcd(i + 1);
    stamp(header, o + 3, i === 0 && zeros[i] === undefined && !tracks[i].pregap ? 0 : z);
    stamp(header, o + 7, start);
  }
  Buffer.from("kHn ").copy(header, 0x400); header.writeUInt32LE(count, 0x408); header.writeUInt32LE(count, 0x40c);
  const bytes = VCD_HEADER_BYTES + count * VCD_SECTOR_BYTES;
  checkVcdHeader(header, bytes);
  return { header, gaps, size, bytes, sourceMtime: sourceStat.mtimeMs };
}

export async function convertToVcd(binPath: string, cuePath: string, output: string,
  progress?: (percent: number, stage: string) => void): Promise<void> {
  const plan = await planVcd(binPath, cuePath);
  let owned = false;
  // Open exclusively: even direct callers must never truncate a pre-existing file.
  const handle = await fs.open(output, "wx"); owned = true;
  try {
    let copied = 0;
    const payload = async function* () {
      yield plan.header;
      let position = 0;
      for (const gap of [...plan.gaps, { at: plan.size / VCD_SECTOR_BYTES, length: 0 }]) {
        const end = gap.at * VCD_SECTOR_BYTES;
        if (end > position) {
          for await (const chunk of createReadStream(binPath, { start: position, end: end - 1 })) {
            copied += chunk.length; progress?.(Math.round(copied / plan.size * 95), "Writing VCD tracks"); yield chunk;
          }
        }
        let remaining = gap.length * VCD_SECTOR_BYTES;
        const zero = Buffer.alloc(64 * VCD_SECTOR_BYTES);
        while (remaining) { const n = Math.min(remaining, zero.length); yield zero.subarray(0, n); remaining -= n; }
        position = end;
      }
      if (copied !== plan.size) throw new Error("Source BIN changed or was interrupted while converting.");
      const after = await fs.stat(binPath);
      if (after.size !== plan.size || after.mtimeMs !== plan.sourceMtime) throw new Error("Source BIN changed while converting.");
    };
    await pipeline(Readable.from(payload()), createWriteStream(output, { fd: handle.fd, autoClose: false }));
    await handle.sync();
    await validateVcd(output);
    progress?.(100, "VCD validated");
  } catch (error) {
    await handle.close().catch(() => {});
    if (owned) await fs.unlink(output).catch(() => {});
    throw error;
  }
  await handle.close();
}
