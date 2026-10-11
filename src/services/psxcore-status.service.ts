import * as fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

export interface PsxcoreFiles { revisionFile?: string; bootstrap?: string; pops?: string; iop?: string }
interface Identity { bytes: number; sha256: string }
export interface PsxcoreRevision {
  revision: string;
  fileRequestVersion: 6;
  fileRequestBytes: 1072;
  bootstrap: Identity | null;
}
// Pinned in current PSXCore runtime/main.c and LUNA devices/psxcore_disc.c.
export const PSXCORE_ASSETS = {
  pops: { bytes: 3166988, sha256: "59df3389c4df88a572daa720b05507c52c34eddfa0031a6fbeec55e0c2d0fcb1" },
  iop: { bytes: 265233, sha256: "3338b238d84d7d586b716677e3a1c03b2088b882ecfa17f91fc33798931ca3ba" },
};
const SOURCE_REVISION: PsxcoreRevision = {
  revision: "Local PSXCore source contract (2026-10-11)", fileRequestVersion: 6, fileRequestBytes: 1072,
  // The available 2026-10-10 bootstrap predates the current card/ABI source.
  // Never certify an old binary just because it is an ELF or has this name.
  bootstrap: null,
};
export async function readPsxcoreRevision(file?: string): Promise<PsxcoreRevision> {
  if (!file) return SOURCE_REVISION;
  if ((await fs.stat(file)).size > 65536) throw new Error("Revision fingerprint is too large.");
  const r = JSON.parse(await fs.readFile(file, "utf8"));
  if (typeof r.revision !== "string" || !r.revision.trim() || r.revision.length > 200 ||
      r.fileRequestVersion !== 6 || r.fileRequestBytes !== 1072 || !r.bootstrap ||
      !Number.isSafeInteger(r.bootstrap.bytes) || r.bootstrap.bytes < 52 || r.bootstrap.bytes > 16 * 1024 * 1024 ||
      typeof r.bootstrap.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(r.bootstrap.sha256))
    throw new Error("Fingerprint must describe a v6, 1072-byte PSXCore revision with the bootstrap's exact byte count and SHA-256.");
  if (r.bootstrap.sha256.toLowerCase() === "b6b3ccb3f73e6b8c36014d77e34ce7959fc663d0c3f0eff210442d899df92d30")
    throw new Error("This known local bootstrap was built from superseded source and cannot be certified for v6.");
  return r;
}

export async function verifyPsxcoreFile(file: string | undefined, identity: Identity | null, elf = false) {
  if (!file) return { valid: false, message: "Missing — select the separately supplied file." };
  if (!identity) return { valid: false, message: "Revision unverified — select a trusted fingerprint from a matching v6 build. The available local bootstrap predates current source." };
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

/** Read-only. Bootstrap installation is intentionally unavailable: current
 * LUNA has no executable bootstrap path or ordinary-storage PS1 handoff. */
export async function getPsxcoreStatus(root: string, files: PsxcoreFiles = {}) {
  const revision = await readPsxcoreRevision(files.revisionFile);
  return {
    revision: revision.revision,
    bootstrap: await verifyPsxcoreFile(files.bootstrap, revision.bootstrap, true),
    pops: await verifyPsxcoreFile(files.pops || path.join(root, "POPS", "POPS.ELF"), PSXCORE_ASSETS.pops, true),
    iop: await verifyPsxcoreFile(files.iop || path.join(root, "POPS", "IOPRP252.IMG"), PSXCORE_ASSETS.iop),
    readyToLaunch: false,
    message: "Preparation only. LUNA needs ordinary-storage /POPS/*.VCD discovery and a production PSXCore handoff. No bootstrap installation location exists in the current LUNA integration. Runtime assets default to /POPS. Executable backends: ATA and USB.",
  };
}
