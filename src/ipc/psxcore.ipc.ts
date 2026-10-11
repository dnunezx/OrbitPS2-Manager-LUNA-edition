import { ipcMain, dialog } from "electron";
import { getSettings, setSetting } from "../services/settings.service";
import { getPsxcoreStatus, PsxcoreFiles } from "../services/psxcore-status.service";

export function registerPsxcoreIpc() {
  ipcMain.handle("psxcore-status", async (_event, root: string) => {
    try { return { success: true, ...await getPsxcoreStatus(root, getSettings().psxcoreFiles) }; }
    catch (error: any) { return { success: false, message: error.message }; }
  });
  ipcMain.handle("psxcore-select-file", async (_event, kind: keyof PsxcoreFiles) => {
    const types = { revisionFile: ["json"], bootstrap: ["elf"], pops: ["elf"], iop: ["img"] };
    if (!Object.prototype.hasOwnProperty.call(types, kind)) throw new Error("Unknown PSXCore file type.");
    const result = await dialog.showOpenDialog({ properties: ["openFile"],
      title: kind === "revisionFile" ? "Select trusted PSXCore build revision fingerprint" : `Select PSXCore ${kind} file (read-only)`,
      filters: [{ name: "PSXCore prerequisite", extensions: types[kind] }] });
    if (!result.canceled && result.filePaths[0]) {
      setSetting("psxcoreFiles", { ...getSettings().psxcoreFiles, [kind]: result.filePaths[0] });
    }
    return result;
  });
}
