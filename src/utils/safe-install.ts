import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";

export async function ensureChildDirectory(root: string, child: string) {
  const dir = path.join(root, child);
  await fs.mkdir(dir, { recursive: true });
  const realRoot = await fs.realpath(root), realDir = await fs.realpath(dir);
  if (path.dirname(realDir).toLowerCase() !== realRoot.toLowerCase() || (await fs.lstat(dir)).isSymbolicLink())
    throw new Error(`Destination ${child} must be an ordinary folder on the selected drive.`);
  return dir;
}

export async function requireSpace(directory: string, bytes: number) {
  const stat = await fs.statfs(directory);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (available < bytes + 8 * 1024 * 1024)
    throw new Error(`Insufficient free space: need ${Math.ceil((bytes + 8 * 1024 * 1024) / 1048576)} MiB on ${directory}.`);
}

export async function assertAbsent(file: string) {
  const names = await fs.readdir(path.dirname(file));
  if (names.some(n => n.toLowerCase() === path.basename(file).toLowerCase()))
    throw new Error(`Destination already exists; it will not be replaced: ${file}`);
}

/** Temp input has already passed validation. Publish with no replacement.
 * Hard links give atomic placement where available. FAT uses an exclusive
 * copy; failed writes remove only the destination this operation created. */
export async function publishFile(temp: string, final: string, validate: (p: string) => Promise<unknown>) {
  await assertAbsent(final);
  try {
    await fs.link(temp, final);
  } catch (error: any) {
    // Windows reports unsupported hard links on FAT/exFAT as EISDIR.
    const unsupportedWindowsLink = process.platform === "win32" && error.code === "EISDIR";
    if (!unsupportedWindowsLink && !["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(error.code)) throw error;
    if (unsupportedWindowsLink && !(await fs.lstat(temp)).isFile()) throw error;
    const handle = await fs.open(final, "wx");
    try {
      await pipeline(createReadStream(temp), createWriteStream(final, { fd: handle.fd, autoClose: false }));
      await handle.sync();
    } catch (failure) {
      await handle.close().catch(() => {}); await fs.unlink(final).catch(() => {}); throw failure;
    }
    await handle.close();
  }
  try { await validate(final); }
  catch (error) { await fs.unlink(final).catch(() => {}); throw error; }
}

export async function uniqueVcdPath(directory: string, stem: string) {
  const names = new Set((await fs.readdir(directory)).map(n => n.toLowerCase()));
  for (let n = 1; n < 10000; n++) {
    const name = `${stem}${n === 1 ? "" : ` (${n})`}.VCD`;
    if (Buffer.byteLength(`/POPS/${name}`) >= 256) throw new Error("Title is too long for PSXCore's 256-byte disc path. Shorten the title.");
    if (!names.has(name.toLowerCase())) return path.join(directory, name);
  }
  throw new Error("No available filename for this disc.");
}
