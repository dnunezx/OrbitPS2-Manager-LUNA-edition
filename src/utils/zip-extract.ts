import AdmZip from "adm-zip";
import * as fs from "fs/promises";
import * as os from "os";
import path from "path";
import { createLogger } from "../logger";
import { requireSpace } from "./safe-install";

const log = createLogger("zip-extract");

export interface ExtractedDiscZip {
  tempDir: string;
  cuePath: string | null;
  binPath: string | null;
}

export function listZipDiscs(zipPath: string): string[] {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const names = new Set<string>();
  for (const e of entries) {
    const n = e.entryName.replace(/\\/g, "/");
    if (n.startsWith("/") || /[:\u0000-\u001f\u007f]/.test(n) || n.split("/").includes("..") ||
        (e.header.attr >>> 16 & 0xf000) === 0xa000) throw new Error("ZIP contains unsafe paths or symbolic links.");
    if (names.has(n.toLowerCase())) throw new Error("ZIP contains ambiguous duplicate paths.");
    names.add(n.toLowerCase());
  }
  return entries.filter(e => !e.isDirectory && !e.entryName.replace(/\\/g, "/").split("/").includes("__MACOSX") &&
    /\.(cue|vcd)$/i.test(e.entryName)).map(e => e.entryName).sort();
}

export async function extractSelectedDiscZip(zipPath: string, selected?: string): Promise<{ tempDir: string; discPath: string }> {
  const discs = listZipDiscs(zipPath);
  if (!discs.length) throw new Error("ZIP needs CUE + referenced BIN tracks or a valid VCD. A BIN alone lacks track information.");
  if (!selected && discs.length > 1) throw new Error("Archive contains multiple discs. Select a disc before importing.");
  const name = selected || discs[0];
  if (!discs.includes(name)) throw new Error("Selected disc is no longer present in the archive.");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "luna-ps1-zip-"));
  try {
    const zip = new AdmZip(zipPath);
    await requireSpace(tempDir, zip.getEntries().reduce((n, e) => n + e.header.size, 0));
    zip.extractAllTo(tempDir, false);
    return { tempDir, discPath: path.join(tempDir, name.replace(/\\/g, "/")) };
  } catch (error) { await fs.rm(tempDir, { recursive: true, force: true }); throw error; }
}

async function findFirstByExt(dir: string, ext: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "__MACOSX") continue;
      subdirs.push(path.join(dir, entry.name));
      continue;
    }
    if (path.extname(entry.name).toLowerCase() === ext) {
      return path.join(dir, entry.name);
    }
  }

  for (const subdir of subdirs) {
    const found = await findFirstByExt(subdir, ext);
    if (found) return found;
  }
  return null;
}

/**
 * Extracts a ZIP archive (expected to contain a PS1 disc's .cue + .bin
 * pair) to a fresh temp directory and locates the .cue/.bin inside,
 * wherever they sit in the archive's folder structure. Caller owns the
 * returned tempDir and must remove it once done (see cleanupExtractedZip).
 */
export async function extractDiscZip(zipFilePath: string): Promise<ExtractedDiscZip> {
  const tempDir = path.join(
    os.tmpdir(),
    `orbitps2-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.mkdir(tempDir, { recursive: true });

  try {
  log.verbose(`Extracting ${path.basename(zipFilePath)} → ${tempDir}`);
  const discs = listZipDiscs(zipFilePath);
  if (discs.length > 1) throw new Error("Archive contains multiple discs. Select a disc on the Import screen.");
  const zip = new AdmZip(zipFilePath);
  await requireSpace(tempDir, zip.getEntries().reduce((n, e) => n + e.header.size, 0));
  zip.extractAllTo(tempDir, false);
  const cuePath = await findFirstByExt(tempDir, ".cue");
  const binPath = await findFirstByExt(tempDir, ".bin");
  log.verbose(
    `Extracted ${path.basename(zipFilePath)}: cue=${cuePath ? path.basename(cuePath) : "none"}, bin=${binPath ? path.basename(binPath) : "none"}`
  );

  return { tempDir, cuePath, binPath };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupExtractedZip(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err: any) {
    log.warn(`Failed to clean up extracted ZIP temp dir ${tempDir}:`, err?.message || err);
  }
}
