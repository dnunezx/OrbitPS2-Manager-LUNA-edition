import { ipcMain } from "electron";
import { importPs2CdGame } from "../services/cd-import.service";
import { importPs1Game } from "../services/ps1-import.service";
import { importApp } from "../services/apps.service";
import { inspectPs1Source } from "../services/ps1-source.service";
import { validateVcd } from "../utils/psxcore-vcd";

export function registerImportIpc(): void {
  ipcMain.handle("inspect-ps1-source", async (_event, file: string) => {
    try { return { success: true, ...await inspectPs1Source(file) }; }
    catch (error: any) { return { success: false, message: error.message }; }
  });
  ipcMain.handle("validate-ps1-vcd", async (_event, file: string) => {
    try { return { success: true, ...await validateVcd(file) }; }
    catch (error: any) { return { success: false, message: error.message }; }
  });
  ipcMain.handle(
    "import-ps2-cd-game",
    async (
      event,
      cueFilePath: string,
      oplRoot: string,
      gameId: string | undefined,
      gameName: string | undefined,
      downloadArtwork: boolean
    ) => {
      return importPs2CdGame(
        cueFilePath,
        oplRoot,
        gameId,
        gameName,
        downloadArtwork,
        (percent, stage) => {
          event.sender.send("ps2-cd-import-progress", { percent, stage });
        }
      );
    }
  );

  ipcMain.handle(
    "import-ps1-game",
    async (
      event,
      cueFilePath: string,
      oplRoot: string,
      elfPrefix: string,
      downloadArtwork: boolean,
      gameId?: string,
      gameName?: string,
      launcherMode?: "popstarter" | "popsloader" | "psxcore",
      archiveEntry?: string
    ) => {
      return importPs1Game(
        cueFilePath,
        oplRoot,
        elfPrefix,
        downloadArtwork,
        gameId,
        gameName,
        launcherMode,
        (percent, stage) => {
          event.sender.send("ps1-import-progress", { percent, stage });
        },
        archiveEntry
      );
    }
  );

  ipcMain.handle(
    "import-app",
    async (_event, oplRoot: string, elfPath: string, title: string) => {
      return importApp(oplRoot, elfPath, title);
    }
  );
}
