// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import * as fs from "fs/promises";
import path from "path";
import https from "https";
import { dialog, nativeImage } from "electron";
import { createLogger, formatBytes } from "../logger";
import { fillGameMetadata } from "./game-metadata.service";
import { ensureChildDirectory } from "../utils/safe-install";
import { artRemoteFileNames, artSlotFileNames } from "./artwork-filenames";
import { validateArtworkPng } from "../utils/png-artwork";

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

export type ArtDownloader = (url: string, fileName: string) => Promise<Buffer>;

/**
 * How long a single candidate may take before the socket is torn down. A wide
 * candidate list walks up to ~32 URLs per game, so without a ceiling one hung
 * response keeps the whole bulk run — and the modal waiting on it — alive until
 * the process is killed.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

async function downloadBuffer(url: string, fileName: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        // Release the socket. A response that is neither drained nor destroyed
        // stays parked in the keep-alive pool, and a bulk run repeats this for
        // every candidate it misses.
        res.resume();
        reject(new Error(`Failed to download ${fileName}: ${res.statusCode}`));
        return;
      }
      const data: Buffer[] = [];
      res.on("data", (chunk) => data.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve(Buffer.concat(data)));
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out downloading ${fileName}`));
    });
    request.on("error", reject);
  });
}

/**
 * Download the requested art types for one game.
 *
 * Every type is fetched over the single HTTPS path below — `downloader` exists
 * so tests can fake the network. For each type the candidate names from
 * `artRemoteFileNames` are walked in order and the first hit is written under
 * the local name of the type that was requested (`<localName>_<type>.png`).
 *
 * - `saveAsByType` overrides only the *local* name, never the request: the
 *   wizard picks a concrete database file (`SCR_05`, `BG_02`) and stores it as
 *   the base file OPL reads (`SCR`, `BG`).
 * - `wideSlotFallback` widens the candidate list with the remaining indexed
 *   variants of the family, so a bulk run still fills `SCR`/`SCR2`/`BG` for a
 *   game whose database holds only, say, `SCR_05`.
 *
 * A remote file is downloaded at most once per call: whichever type claims it
 * first keeps it and every later type drops it from its candidates. Without that
 * a game whose database holds a single indexed variant would fill each slot from
 * the same image — `SCR_05` landing in both `SCR` and `SCR2`, overwriting a real
 * second screenshot with a copy of the first. A slot with no unique candidate
 * left is reported as missing rather than filled with a duplicate.
 *
 * A candidate that cannot be *fetched* is walked past, but a candidate that
 * cannot be *written* ends that type: the bytes are already in hand, so every
 * remaining URL would only re-download the same image and then 404.
 */
export async function downloadArtByGameId(
  dirPath: string,
  gameId: string,
  system: "PS1" | "PS2" = "PS2",
  saveAsName?: string,
  artTypes?: string[],
  downloaderOrPreserve: ArtDownloader | boolean = downloadBuffer,
  saveAsByType?: Record<string, string>,
  wideSlotFallback = false
) {
  const downloader = typeof downloaderOrPreserve === "function" ? downloaderOrPreserve : downloadBuffer;
  const preserveExisting = downloaderOrPreserve === true;
  const baseUrl = `https://raw.githubusercontent.com/Luden02/psx-ps2-opl-art-database/refs/heads/main/${system}`;
  const types =
    artTypes ?? (system === "PS2" ? ["COV", "ICO", "SCR", "LGO", "PSBBN"] : ["COV", "ICO", "SCR", "LGO"]);
  const results: any[] = [];
  const localName = saveAsName || gameId;
  // Independent of cover availability: absent artwork still gets metadata.
  const metadataTask = downloader === downloadBuffer
    ? fillGameMetadata(path.dirname(dirPath), [gameId], system)
      .catch((error) => [{ gameId, success: false, message: String(error) }])
    : Promise.resolve([]);
  /** Remote files already written by an earlier type of this call. */
  const claimed = new Set<string>();

  log.info(
    `Downloading ${system} artwork for ${gameId} (${types.join(", ")}) into ${dirPath}`
  );

  // Create the target folder once, up front. Callers that already made it are
  // unaffected; the bulk and wizard paths never do, and without this every write
  // is the first thing to find the folder missing.
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err: any) {
    const message = `Could not create artwork folder ${dirPath}: ${err.message}`;
    log.error(message);
    return {
      success: false,
      data: types.map((type) => ({ name: localName, type, url: "", error: message })),
      message,
    };
  }

  for (const type of types) {
    const isPsbbn = type.toUpperCase() === "PSBBN";
    const candidates = isPsbbn ? [`${gameId}.png`] : wideSlotFallback
      ? artSlotFileNames(gameId, type, claimed)
      : artRemoteFileNames(gameId, type, claimed);
    // OPL only reads the base asset file, so an indexed code (e.g. `SCR_05`)
    // is fetched by code but written under the base name it maps to.
    const saveType = saveAsByType?.[type] ?? type;
    const savePath = isPsbbn ? path.join(dirPath, "PSBBN", `${gameId}.png`) : path.join(dirPath, `${localName}_${saveType}.png`);
    let lastUrl = "";
    let lastError: Error | null = null;
    let saved = false;

    if (candidates.length === 0) {
      lastError = new Error(
        `No unique ${type} artwork left — every candidate was already saved.`
      );
    }

    for (const fileName of candidates) {
      const url = isPsbbn ? `${PSBBN_ART_BASE_URL}/${encodeURIComponent(gameId)}.png` : `${baseUrl}/${gameId}/${fileName}`;
      lastUrl = url;
      log.verbose(`GET ${url}`);

      let buffer: Buffer;
      try {
        buffer = await downloader(url, fileName);
      } catch (err: any) {
        // The candidate is simply not in the database, or the socket failed —
        // both are answered by walking on to the next one.
        lastError = err;
        const isLastCandidate = fileName === candidates[candidates.length - 1];
        if (!isLastCandidate) {
          log.verbose(
            `${type} candidate ${fileName} failed for ${gameId}, trying next: ${err.message}`
          );
        }
        continue;
      }

      // Real downloads always validate the RiptOPL/OPL PNG contract. A
      // mismatch is only warned about — the original bytes are written anyway,
      // rather than losing an asset. Test downloaders are skipped, so the
      // sentinel bytes they return never trip the validator.
      if (downloader === downloadBuffer && !isPsbbn) {
        const { expected, failures } = validateArtworkPng(
          buffer,
          system,
          saveType,
        );
        if (failures.length > 0) {
          log.warn(
            `${type} artwork for ${localName} may not display: ${failures.join("; ")}` +
              (expected ? ` (expected ${expected.width}x${expected.height})` : ""),
          );
        }
      }

      try {
        if (isPsbbn) {
          if (downloader === downloadBuffer) {
            const image = nativeImage.createFromBuffer(buffer);
            if (image.isEmpty()) throw new Error("Downloaded PSBBN artwork is not a valid image");
            const { width, height } = image.getSize(), edge = Math.min(width, height);
            buffer = image.crop({ x: Math.floor((width - edge) / 2), y: Math.floor((height - edge) / 2), width: edge, height: edge })
              .resize({ width: 256, height: 256, quality: "best" }).toPNG();
          }
          if (preserveExisting) await ensureChildDirectory(dirPath, "PSBBN");
          else await fs.mkdir(path.dirname(savePath), { recursive: true });
        }
        await fs.writeFile(savePath, buffer, preserveExisting ? { flag: "wx" } : undefined);
      } catch (err: any) {
        // The bytes are already in hand, so a local write failure says nothing
        // about the remaining candidates: fetching them again would re-download
        // this same image once per URL left and 404 on all of them.
        lastError = new Error(
          `Failed to save ${type} artwork to ${savePath}: ${err.message}`
        );
        log.warn(lastError.message);
        break;
      }

      log.verbose(`Saved ${type} artwork (${formatBytes(buffer.length)}) → ${savePath}`);
      results.push({
        name: localName,
        type,
        source: isPsbbn ? "PSBBN" : fileName.slice(gameId.length + 1).replace(/\.png$/i, ""),
        url,
        savedPath: savePath,
      });
      claimed.add(fileName);
      saved = true;
      break;
    }

    if (!saved) {
      log.verbose(
        `${type} artwork unavailable for ${gameId}: ${lastError?.message ?? `Failed to download ${type}`}`
      );
      results.push({
        name: localName,
        type,
        url: lastUrl,
        error: lastError?.message ?? `Failed to download ${type}`,
      });
    }
  }

  const saved = results.filter((r) => r.savedPath).length;
  const metadata = await metadataTask;
  for (const result of metadata) {
    if (!result.success) log.warn(`Game metadata for ${gameId}: ${result.message}`);
  }
  log.info(`Artwork for ${gameId}: ${saved}/${types.length} file(s) downloaded`);
  if (saved === 0) {
    const msg = `No artwork found for ${gameId} in ${system} database.`;
    log.warn(msg);
    return { success: false, data: results, message: msg, metadata };
  }
  return { success: true, data: results, metadata };
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

    if (gameId) {
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
