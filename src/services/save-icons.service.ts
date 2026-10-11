// PS2IODB stores converted PS2 memory-card icons as OBJ models and PNG textures.
import * as fs from "fs/promises";
import path from "path";
import https from "https";
import { createLogger } from "../logger";
import { renderSaveIconPreview } from "./save-icon-renderer";

const log = createLogger("save-icons");
const BASE = "https://raw.githubusercontent.com/Issung/PS2IODB/main/website";
const CATALOG_URL = `${BASE}/src/model/Titles.ts`;
const MAX_CATALOG = 2 * 1024 * 1024;
const MAX_ASSET = 4 * 1024 * 1024;
const SPIN_FRAMES = 12;
type Entry = { title: string; code: string };
type IconSys = { title?: string; normal?: string; copy?: string; delete?: string };
let catalogPromise: Promise<Map<string, Entry[]>> | undefined;

function get(url: string, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 20000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Icon source returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          request.destroy(new Error("Icon source file exceeds size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Icon source timed out")));
    request.on("error", reject);
  });
}

function key(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCatalog(source: string): Map<string, Entry[]> {
  const entries = new Map<string, Entry[]>();
  const add = (title: string, code: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(code)) return;
    const normalized = key(title);
    if (!normalized) return;
    entries.set(normalized, [...(entries.get(normalized) ?? []), { title, code }]);
  };
  // Catalog constructors use static template literals. Uncontributed titles have
  // no code and are intentionally excluded. Multi-icon titles remain ambiguous.
  for (const match of Array.from(source.matchAll(/new Game\(`([^`]*)`,\s*`([^`]*)`/g))) {
    add(match[1], match[2]);
  }
  for (const game of Array.from(source.matchAll(/new Game\(`([^`]*)`,\s*\w+\s*=>\s*\[([\s\S]*?)\]\s*\)/g))) {
    for (const icon of Array.from(game[2].matchAll(/new Icon\(\w+,\s*`[^`]*`,\s*`([^`]*)`/g))) {
      add(game[1], icon[1]);
    }
  }
  if (entries.size < 100) throw new Error("Icon catalog format was not recognized");
  return entries;
}

async function catalog(): Promise<Map<string, Entry[]>> {
  if (!catalogPromise) {
    catalogPromise = get(CATALOG_URL, MAX_CATALOG)
      .then((body) => parseCatalog(body.toString("utf8")))
      .catch((error) => { catalogPromise = undefined; throw error; });
  }
  return catalogPromise;
}

function safeModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) &&
    value !== "." && value !== "..";
}

function renderIconImages(obj: string, png: Buffer) {
  // The grid uses a fixed three-quarter camera like the PS2 browser.
  // Selected icons still use their separate full rotation frames.
  const preview = renderSaveIconPreview(obj, png, {
    yawOffset: -0.36, pitchOffset: -0.14,
  });
  const spin = Array.from({ length: SPIN_FRAMES }, (_, frame) =>
    renderSaveIconPreview(obj, png, {
      yawOffset: frame * 2 * Math.PI / SPIN_FRAMES, size: 160,
    })
  );
  return { preview, spin };
}

async function writeIconImages(target: string, images: ReturnType<typeof renderIconImages>) {
  await fs.mkdir(path.join(target, "spin"), { recursive: true });
  await fs.writeFile(path.join(target, "preview.png"), images.preview);
  for (let frame = 0; frame < images.spin.length; frame++) {
    await fs.writeFile(path.join(target, "spin", `${String(frame).padStart(2, "0")}.png`), images.spin[frame]);
  }
}

export async function downloadSaveIcon(
  oplRoot: string, gameId: string, title: string
): Promise<{ success: boolean; message: string; savedPath?: string }> {
  if (!/^[A-Z]{4}_\d{3}\.\d{2}$/i.test(gameId) || !title.trim()) {
    return { success: false, message: "A valid PS2 game ID and title are required." };
  }
  const id = gameId.toUpperCase();
  const target = path.join(oplRoot, "ART", "SAVEICON", id);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
    try {
      await fs.access(path.join(target, "preview.png"));
      await fs.access(path.join(target, "spin", "11.png"));
      if (manifest.format !== 3) throw new Error("Grid angle needs refresh");
      return { success: true, message: "Save icon already installed.", savedPath: target };
    } catch {
      if (safeModelName(manifest.normal)) {
        const obj = await fs.readFile(path.join(target, `${manifest.normal}.obj`), "utf8");
        const png = await fs.readFile(path.join(target, `${manifest.normal}.png`));
        await writeIconImages(target, renderIconImages(obj, png));
        manifest.format = 3;
        manifest.spinFrames = SPIN_FRAMES;
        manifest.spinIntervalMs = 180;
        await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
        return { success: true, message: "Save icon preview and rotation generated.", savedPath: target };
      }
    }
  } catch { /* No complete older bundle: download it below. */ }

  try {
    const candidates = (await catalog()).get(key(title)) ?? [];
    const codes = Array.from(new Set(candidates.map((entry) => entry.code)));
    if (!codes.length) {
      return { success: false, message: `No exact PS2IODB title match for “${title}”.` };
    }
    if (codes.length !== 1) {
      return { success: false, message: `Multiple save icons exist for “${title}”; choose a variant manually later.` };
    }
    const code = codes[0];
    const source = `${BASE}/public/icons/${encodeURIComponent(code)}`;
    const iconSys = JSON.parse((await get(`${source}/iconsys.json`, 65536)).toString("utf8")) as IconSys;
    const models = Array.from(new Set([iconSys.normal, iconSys.copy, iconSys.delete]));
    if (!models.length || models.some((model) => !safeModelName(model))) {
      throw new Error("Icon metadata contains invalid model filenames");
    }

    const files = new Map<string, Buffer>();
    for (const model of models as string[]) {
      for (const ext of ["obj", "mtl", "png"]) {
        const file = `${model}.${ext}`;
        const bytes = await get(`${source}/${encodeURIComponent(file)}`, MAX_ASSET);
        if (!bytes.length || (ext === "png" &&
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) {
          throw new Error(`Invalid icon asset: ${file}`);
        }
        files.set(file, bytes);
      }
    }
    const normal = iconSys.normal as string;
    const images = renderIconImages(
      files.get(`${normal}.obj`)!.toString("utf8"), files.get(`${normal}.png`)!
    );
    await fs.mkdir(target, { recursive: true });
    for (const [file, bytes] of Array.from(files)) await fs.writeFile(path.join(target, file), bytes);
    await writeIconImages(target, images);
    await fs.writeFile(path.join(target, "iconsys.json"), JSON.stringify(iconSys, null, 2));
    const manifest = {
      format: 3, spinFrames: SPIN_FRAMES, spinIntervalMs: 180, gameId: id, gameTitle: title, source: "PS2IODB", sourceCode: code,
      normal: iconSys.normal, copy: iconSys.copy, delete: iconSys.delete,
    };
    // Written last: the presence of this file means the bundle is complete.
    await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
    log.info(`Installed save icon for ${id} (${title}) at ${target}`);
    return { success: true, message: "Save icon installed.", savedPath: target };
  } catch (error: any) {
    const message = error?.message || String(error);
    log.warn(`Save icon for ${id} (${title}) unavailable: ${message}`);
    return { success: false, message };
  }
}
