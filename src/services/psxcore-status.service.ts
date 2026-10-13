import * as fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

export interface PsxcoreFiles { pops?: string; iop?: string }
interface Identity { bytes: number; sha256: string }
// Pinned in current PSXCore runtime/main.c and LUNA devices/psxcore_disc.c.
export const PSXCORE_ASSETS = {
  pops: { bytes: 3166988, sha256: "59df3389c4df88a572daa720b05507c52c34eddfa0031a6fbeec55e0c2d0fcb1" },
  iop: { bytes: 265233, sha256: "3338b238d84d7d586b716677e3a1c03b2088b882ecfa17f91fc33798931ca3ba" },
};
export async function verifyPsxcoreFile(file: string | undefined, identity: Identity, elf = false) {
  if (!file) return { valid: false, message: "Missing — select the separately supplied file." };
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== identity.bytes) throw new Error("Incompatible file size for the selected revision.");
    const data = await fs.readFile(file);
    if (elf && (data.toString("hex", 0, 4) !== "7f454c46" || data[4] !== 1 || data[5] !== 1 || data.readUInt16LE(18) !== 8))
      throw new Error("Expected a PS2 ELF32 little-endian MIPS executable.");
    if (createHash("sha256").update(data).digest("hex") !== identity.sha256.toLowerCase()) throw new Error("SHA-256 does not match the selected revision.");
    return { valid: true, message: "Size and SHA-256 verified.", path: file };
  } catch (error: any) { return { valid: false, message: error.code === "ENOENT" ? "Missing file." : error.message }; }
}

/** Read-only drive checks. The bootstrap is installed on the PS2 memory card. */
export async function getPsxcoreStatus(root: string, files: PsxcoreFiles = {}) {
  return {
    pops: await verifyPsxcoreFile(files.pops || path.join(root, "POPS", "POPS.ELF"), PSXCORE_ASSETS.pops, true),
    iop: await verifyPsxcoreFile(files.iop || path.join(root, "POPS", "IOPRP252.IMG"), PSXCORE_ASSETS.iop),
    readyToLaunch: false,
    message: "The PSXCore bootstrap is installed on the PS2 memory card and is not checked here. These read-only checks cover POPS.ELF and IOPRP252.IMG, which default to /POPS on the selected drive. Status does not block game preparation or verify the console installation.",
  };
}
