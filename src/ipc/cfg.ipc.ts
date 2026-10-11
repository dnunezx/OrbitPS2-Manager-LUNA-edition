import { ipcMain } from "electron";
import { readGameGenres, assignGameGenres, fillGameGenres, GENRE_LABELS } from "../services/genres.service";
import { readGameCfg, writeGameCfg, patchGameCfg, GameCfg } from "../services/cfg.service";
import { lookupGameMetadata, fillGameMetadata } from "../services/game-metadata.service";
import {
  readAppTitleCfg,
  updatePs1TitleCfg,
} from "../services/apps.service";

export function registerCfgIpc(): void {
  ipcMain.handle("lookup-game-metadata", (_event, gameId: string) => lookupGameMetadata(gameId));
  ipcMain.handle("fill-game-metadata", (_event, root: string, ids: string[], system: "PS1" | "PS2" = "PS2") => fillGameMetadata(root, ids, system));
  ipcMain.handle("patch-game-cfg", (_event, root: string, gameId: string, changes: Record<string, string | null>) => patchGameCfg(root, gameId, changes));
  ipcMain.handle("genre-labels", () => [...GENRE_LABELS]);
  ipcMain.handle("read-game-genres", (_event, root: string, ids: string[]) => readGameGenres(root, ids));
  ipcMain.handle("assign-game-genres", (_event, root: string, ids: string[], genre: string) => assignGameGenres(root, ids, genre));
  ipcMain.handle("fill-game-genres", (_event, root: string, ids: string[], system: "PS1" | "PS2" = "PS2") => fillGameGenres(root, ids, system));
  ipcMain.handle(
    "read-app-title-cfg",
    async (_event, oplRoot: string, folder: string) => {
      return readAppTitleCfg(oplRoot, folder);
    }
  );

  ipcMain.handle(
    "read-game-cfg",
    async (_event, oplRoot: string, gameId: string) => {
      return readGameCfg(oplRoot, gameId);
    }
  );

  ipcMain.handle(
    "write-game-cfg",
    async (_event, oplRoot: string, gameId: string, entries: GameCfg) => {
      return writeGameCfg(oplRoot, gameId, entries);
    }
  );

  ipcMain.handle(
    "update-ps1-title-cfg",
    async (_event, launcherPath: string, newTitle: string, gameId?: string) => {
      return updatePs1TitleCfg(launcherPath, newTitle, gameId);
    }
  );
}
