// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import { ipcMain } from "electron";
import {
  downloadArtByGameId,
  checkArtFilesExist,
  importCustomPsbbnArt,
  listAvailableArt,
} from "../services/artwork.service";

export function registerArtworkIpc(): void {
  ipcMain.handle(
    "download-art-by-gameid",
    async (
      _event,
      dirPath: string,
      gameId: string,
      system?: "PS1" | "PS2",
      saveAsName?: string,
      artTypes?: string[]
    ) => {
      return downloadArtByGameId(dirPath, gameId, system || "PS2", saveAsName, artTypes);
    }
  );

  ipcMain.handle("check-art-files-exist", async (_event, artDir: string, filenames: string[]) => {
    return checkArtFilesExist(artDir, filenames);
  });

  ipcMain.handle("list-available-art", async (_event, gameId: string, system?: "PS1" | "PS2") => {
    return listAvailableArt(gameId, system || "PS2");
  });

  ipcMain.handle("import-custom-psbbn-art", async (_event, oplRoot: string, gameId: string) => {
    return importCustomPsbbnArt(oplRoot, gameId);
  });
}
