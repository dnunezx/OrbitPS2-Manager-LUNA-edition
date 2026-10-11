import * as fs from "fs/promises";

export const VCD_HEADER_BYTES = 0x100000;
export const VCD_SECTOR_BYTES = 2352;
export const PSXCORE_MAX_IMAGE_BYTES = 0x7fffffff;

function bcd(value: number): number {
  if ((value & 15) > 9 || (value >> 4) > 9) throw new Error("Invalid VCD BCD timestamp.");
  return (value >> 4) * 10 + (value & 15);
}
function time(h: Buffer, offset: number): number {
  const m = bcd(h[offset]), s = bcd(h[offset + 1]), f = bcd(h[offset + 2]);
  if (s >= 60 || f >= 75) throw new Error("Invalid VCD track timestamp.");
  return m * 4500 + s * 75 + f;
}

/** Port of PSXCore src/vcd.c np_vcd_check, plus file.c's runtime bound
 * and stricter track-entry checks so corrupt track tables cannot pass import. */
export function checkVcdHeader(h: Buffer, size: number): { sectors: number; tracks: number } {
  const fail = (reason: string): never => { throw new Error(`Invalid POPS VCD: ${reason}.`); };
  if (h.length < 0x410) fail("short-header");
  if (h[0] !== 0x41 || h[2] !== 0xa0 || h[7] !== 1 || h[8] !== 0x20 ||
      h[12] !== 0xa1 || h[22] !== 0xa2) fail("unsupported-toc");
  if (h.toString("ascii", 0x400, 0x403) !== "kHn") fail("missing-vcd-marker");
  if (h[0x403] < 0x20 || h[0x403] > 0x23) fail("unsupported-vcd-version");
  const tracks = bcd(h[17]), sectors = h.readUInt32LE(0x408);
  if (tracks < 1 || tracks > 99) fail("invalid-track-count");
  if (!sectors || sectors !== h.readUInt32LE(0x40c)) fail("invalid-sector-count");
  if (size !== VCD_HEADER_BYTES + sectors * VCD_SECTOR_BYTES) fail("payload-size-mismatch");
  if (size > PSXCORE_MAX_IMAGE_BYTES) fail("runtime size limit is 2 GiB minus 1 byte");
  const leadout = bcd(h[26]) * 100 * 4500 + time(h, 27);
  if (leadout !== sectors + 150) fail("leadout-size-mismatch");
  let previous = -1;
  for (let i = 0; i < tracks; i++) {
    const o = 30 + i * 10, start = time(h, o + 7), gap = time(h, o + 3);
    if (![0x41, 0x01].includes(h[o]) || bcd(h[o + 2]) !== i + 1 ||
        (i === 0 && h[o] !== 0x41) || start < 150 || start <= previous ||
        start >= leadout || gap > start || (i > 0 && gap < previous)) fail("invalid-track-table");
    previous = start;
  }
  return { sectors, tracks };
}

export async function validateVcd(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat(), header = Buffer.alloc(0x410);
    if (!stat.isFile()) throw new Error("VCD must be a regular file.");
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return { ...checkVcdHeader(header.subarray(0, bytesRead), stat.size), bytes: stat.size };
  } finally { await handle.close(); }
}
