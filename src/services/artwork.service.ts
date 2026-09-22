// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import * as fs from "fs/promises";
import path from "path";
import https from "https";
import { dialog, nativeImage } from "electron";
import { createLogger, formatBytes } from "../logger";

const log = createLogger("artwork");
const PSBBN_ART_BASE_URL =
  "https://raw.githubusercontent.com/CosmicScale/psbbn-art-database/refs/heads/main/art";

function isSafeArtworkName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function getBuffer(url: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Request failed: ${res.statusCode}`));
        }
        const data: Buffer[] = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () => resolve(Buffer.concat(data)));
      })
      .on("error", reject);
  });
}

async function remoteFileExists(url: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const request = https.request(url, { method: "HEAD" }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Request failed: ${res.statusCode}`));
      });
      request.on("error", reject);
      request.end();
    });
    return true;
  } catch {
    return false;
  }
}

export async function downloadArtByGameId(
  dirPath: string,
  gameId: string,
  system: "PS1" | "PS2" = "PS2",
  saveAsName?: string,
  artTypes?: string[]
) {
  const baseUrl = `https://raw.githubusercontent.com/Luden02/psx-ps2-opl-art-database/refs/heads/main/${system}`;
  const types =
    artTypes ?? (system === "PS2" ? ["COV", "ICO", "SCR", "PSBBN"] : ["COV", "ICO", "SCR"]);
  const results: any[] = [];
  const localName = saveAsName || gameId;

  log.info(
    `Downloading ${system} artwork for ${gameId} (${types.join(", ")}) into ${dirPath}`
  );

  for (const type of types) {
    const isPsbbn = type.toUpperCase() === "PSBBN";
    const fileName = isPsbbn ? `${gameId}.png` : `${gameId}_${type}.png`;
    const url = isPsbbn
      ? `${PSBBN_ART_BASE_URL}/${encodeURIComponent(gameId)}.png`
      : `${baseUrl}/${gameId}/${fileName}`;
    log.verbose(`GET ${url}`);

    try {
      let buffer = await getBuffer(url);

      if (isPsbbn) {
        const source = nativeImage.createFromBuffer(buffer);
        if (source.isEmpty()) throw new Error("Downloaded PSBBN artwork is not a valid image");

        const { width, height } = source.getSize();
        const edge = Math.min(width, height);
        buffer = source
          .crop({
            x: Math.floor((width - edge) / 2),
            y: Math.floor((height - edge) / 2),
            width: edge,
            height: edge,
          })
          .resize({ width: 256, height: 256, quality: "best" })
          .toPNG();
      }

      const savePath = isPsbbn
        ? path.join(dirPath, "PSBBN", `${gameId}.png`)
        : path.join(dirPath, `${localName}_${type}.png`);
      if (isPsbbn) await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, buffer);
      log.verbose(`Saved ${type} artwork (${formatBytes(buffer.length)}) → ${savePath}`);
      results.push({
        name: localName,
        type,
        url,
        savedPath: savePath,
      });
    } catch (err: any) {
      log.verbose(`${type} artwork unavailable for ${gameId}: ${err.message}`);
      results.push({
        name: localName,
        type,
        url,
        error: err.message,
      });
    }
  }

  const saved = results.filter((r) => r.savedPath).length;
  log.info(`Artwork for ${gameId}: ${saved}/${types.length} file(s) downloaded`);
  if (saved === 0) {
    const msg = `No artwork found for ${gameId} in ${system} database.`;
    log.warn(msg);
    return { success: false, data: results, message: msg };
  }
  return { success: true, data: results };
}

export interface AvailableArtEntry {
  type: string;
  fileName: string;
  downloadUrl: string;
}

export async function listAvailableArt(
  gameId: string,
  system: "PS1" | "PS2" = "PS2"
): Promise<{ success: boolean; data: AvailableArtEntry[]; message?: string }> {
  const url = `https://api.github.com/repos/Luden02/psx-ps2-opl-art-database/contents/${system}/${gameId}`;
  log.verbose(`GET ${url}`);

  try {
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      https
        .get(
          url,
          {
            headers: {
              "User-Agent": "OrbitPS2-Manager-LUNA-Edition",
              Accept: "application/vnd.github+json",
            },
          },
          (res) => {
            const data: Buffer[] = [];
            res.on("data", (chunk) => data.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(data).toString("utf-8") })
            );
          }
        )
        .on("error", reject);
    });

    if (body.status === 403) {
      log.warn(`GitHub API rate limit hit while listing art for ${gameId}`);
      return {
        success: false,
        data: [],
        message: "GitHub API rate limit exceeded — try again later.",
      };
    }

    if (body.status !== 200 && body.status !== 404) {
      return {
        success: false,
        data: [],
        message: `Failed to list artwork for ${gameId}: ${body.status}`,
      };
    }

    const prefix = `${gameId}_`;
    const json = body.status === 200 ? JSON.parse(body.text) : [];
    const entries: AvailableArtEntry[] = Array.isArray(json)
      ? json
          .filter((entry: any) => entry?.type === "file" && typeof entry.name === "string")
          .filter((entry: any) => entry.name.startsWith(prefix))
          .map((entry: any) => ({
            type: entry.name.slice(prefix.length).replace(/\.(png|jpg|jpeg)$/i, ""),
            fileName: entry.name,
            downloadUrl: entry.download_url,
          }))
      : [];

    if (system === "PS2") {
      const psbbnUrl = `${PSBBN_ART_BASE_URL}/${encodeURIComponent(gameId)}.png`;
      if (await remoteFileExists(psbbnUrl)) {
        entries.push({
          type: "PSBBN",
          fileName: `${gameId}.png`,
          downloadUrl: psbbnUrl,
        });
      }
    }

    log.info(`Found ${entries.length} artwork file(s) for ${gameId} in ${system} database`);
    return { success: true, data: entries };
  } catch (err: any) {
    log.warn(`Failed to list artwork for ${gameId}: ${err.message}`);
    return { success: false, data: [], message: err.message };
  }
}

export async function importCustomPsbbnArt(
  oplRoot: string,
  gameId: string
): Promise<{
  success: boolean;
  cancelled?: boolean;
  savedPath?: string;
  dataUrl?: string;
  message?: string;
}> {
  if (!isSafeArtworkName(gameId)) {
    return { success: false, message: "Invalid game ID." };
  }

  const selection = await dialog.showOpenDialog({
    title: `Choose PSBBN artwork for ${gameId}`,
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] },
    ],
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return { success: false, cancelled: true, message: "No image selected." };
  }

  const source = nativeImage.createFromPath(selection.filePaths[0]);
  if (source.isEmpty()) {
    return { success: false, message: "The selected image could not be decoded." };
  }

  const { width, height } = source.getSize();
  const edge = Math.min(width, height);
  const square = source.crop({
    x: Math.floor((width - edge) / 2),
    y: Math.floor((height - edge) / 2),
    width: edge,
    height: edge,
  });
  const png = square.resize({ width: 256, height: 256, quality: "best" }).toPNG();
  const psbbnDir = path.join(oplRoot, "ART", "PSBBN");
  const savedPath = path.join(psbbnDir, `${gameId}.png`);
  await fs.mkdir(psbbnDir, { recursive: true });
  await fs.writeFile(savedPath, png);
  log.info(`Saved custom PSBBN artwork (${formatBytes(png.length)}) -> ${savedPath}`);

  return {
    success: true,
    savedPath,
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
  };
}

export async function checkArtFilesExist(artDir: string, filenames: string[]) {
  const existing: string[] = [];
  for (const name of filenames) {
    try {
      await fs.access(path.join(artDir, name));
      existing.push(name);
    } catch {
      // File does not exist — skip.
    }
  }
  return existing;
}
