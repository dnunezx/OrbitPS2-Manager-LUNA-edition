import { registerWindowIpc } from "./window.ipc";
import { registerLibraryIpc } from "./library.ipc";
import { registerDialogIpc } from "./dialog.ipc";
import { registerArtworkIpc } from "./artwork.ipc";
import { registerImportIpc } from "./import.ipc";
import { registerRenameIpc } from "./rename.ipc";
import { registerDeleteIpc } from "./delete.ipc";
import { registerCfgIpc } from "./cfg.ipc";
import { registerAppsIpc } from "./apps.ipc";
import { registerVmcIpc } from "./vmc.ipc";
import { registerZsoIpc } from "./zso.ipc";
import { registerVcdIpc } from "./vcd.ipc";
import { registerSettingsIpc } from "./settings.ipc";
import { registerPsxcoreIpc } from "./psxcore.ipc";

export function registerAllIpc(): void {
  registerWindowIpc();
  registerLibraryIpc();
  registerDialogIpc();
  registerArtworkIpc();
  registerImportIpc();
  registerRenameIpc();
  registerDeleteIpc();
  registerCfgIpc();
  registerAppsIpc();
  registerVmcIpc();
  registerZsoIpc();
  registerVcdIpc();
  registerSettingsIpc();
  registerPsxcoreIpc();
}
