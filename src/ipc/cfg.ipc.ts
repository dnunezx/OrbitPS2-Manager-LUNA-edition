import { ipcMain } from "electron";
import { readGameCfg, writeGameCfg, patchGameCfg, GameCfg } from "../services/cfg.service";
import {
  readAppTitleCfg,
  updatePs1TitleCfg,
} from "../services/apps.service";

export function registerCfgIpc(): void {
  ipcMain.handle("patch-game-cfg", (_event, root: string, gameId: string, changes: Record<string, string | null>) => patchGameCfg(root, gameId, changes));
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
