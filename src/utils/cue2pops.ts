import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import path from "path";
import { sectorsToMsf } from "./cue-parser";
import { validateVcd, VCD_HEADER_BYTES, VCD_SECTOR_BYTES } from "./psxcore-vcd";
import { assertAbsent, publishFile, requireSpace } from "./safe-install";

export { convertToVcd } from "./vcd-converter";
const bcd = (v: number) => (v >> 4) * 10 + (v & 15);
const msf = (h: Buffer, o: number) => bcd(h[o]) * 4500 + bcd(h[o + 1]) * 75 + bcd(h[o + 2]);
function stamp(sectors: number) {
  const t = sectorsToMsf(sectors);
  return [t.minutes, t.seconds, t.frames].map(v => String(v).padStart(2, "0")).join(":");
}

/** Preserve all payload bytes, including silent audio and recorded/synthetic
 * gaps. VCD timestamps use absolute MSF (+150); guessing a gap from zeros
 * can erase legitimate samples. Reconstruct INDEX 00/01 in a single BIN. */
export async function convertVcdToBin(
  vcdPath: string, outputBinPath: string, outputCuePath: string,
  progress?: (percent: number, stage: string) => void
): Promise<{ trackCount: number; hadGap: boolean }> {
  const info = await validateVcd(vcdPath);
  await assertAbsent(outputBinPath); await assertAbsent(outputCuePath);
  await requireSpace(path.dirname(outputBinPath), info.bytes - VCD_HEADER_BYTES);
  const input = await fs.open(vcdPath, "r");
  let temp: string | undefined, installedBin = false;
  try {
    const header = Buffer.alloc(0x410);
    await input.read(header, 0, header.length, 0);
    const lines = [`FILE "${path.basename(outputBinPath)}" BINARY`];
    let hadGap = false;
    for (let i = 0; i < info.tracks; i++) {
      const o = 30 + i * 10, start = msf(header, o + 7) - 150;
      const zero = msf(header, o + 3) - 150;
      let type = "AUDIO";
      if (header[o] === 0x41) {
        const mode = Buffer.alloc(1);
        await input.read(mode, 0, 1, VCD_HEADER_BYTES + start * VCD_SECTOR_BYTES + 15);
        if (mode[0] !== 1 && mode[0] !== 2) throw new Error("Cannot reconstruct data-track mode: raw sector mode must be 1 or 2.");
        type = `MODE${mode[0]}/2352`;
      }
      lines.push(`  TRACK ${String(i + 1).padStart(2, "0")} ${type}`);
      if (zero >= 0 && zero < start) { lines.push(`    INDEX 00 ${stamp(zero)}`); hadGap = true; }
      lines.push(`    INDEX 01 ${stamp(start)}`);
    }
    temp = await fs.mkdtemp(path.join(path.dirname(outputBinPath), ".luna-vcd-export-"));
    const bin = path.join(temp, "disc.bin"), cue = path.join(temp, "disc.cue");
    let copied = 0;
    const counter = new Transform({ transform(chunk, _encoding, done) {
      copied += chunk.length; progress?.(Math.round(copied / (info.bytes - VCD_HEADER_BYTES) * 95), "Extracting BIN tracks");
      done(null, chunk);
    } });
    await pipeline(createReadStream(vcdPath, { start: VCD_HEADER_BYTES }), counter, createWriteStream(bin, { flags: "wx" }));
    if (copied !== info.bytes - VCD_HEADER_BYTES) throw new Error("VCD changed during extraction.");
    await fs.writeFile(cue, lines.join("\n") + "\n", { flag: "wx" });
    const checkBin = async (p: string) => { if ((await fs.stat(p)).size !== copied) throw new Error("Incomplete BIN export."); };
    await publishFile(bin, outputBinPath, checkBin); installedBin = true;
    await publishFile(cue, outputCuePath, async () => {});
    progress?.(100, "BIN/CUE export complete");
    return { trackCount: info.tracks, hadGap };
  } catch (error) {
    if (installedBin) await fs.unlink(outputBinPath).catch(() => {});
    throw error;
  } finally {
    await input.close();
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}
