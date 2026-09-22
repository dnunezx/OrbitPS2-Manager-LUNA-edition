// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
} from "electron";
import path from "path";
import electronReloader from "electron-reloader";
import PackageInfo from "../package.json";
import { createLogger, setLogWindow } from "./logger";
import { registerAllIpc } from "./ipc";

const log = createLogger("main");

const size = { minWidth: 800, minHeight: 600 };

// Tracks whether the renderer has a long-running action in progress.
// Updated via the "set-loading-state" IPC channel from LibraryService.
let rendererIsLoading = false;
let forceCloseRequested = false;

function createWindow() {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: size.minWidth,
    height: size.minHeight,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    title: `OrbitPS2 Manager - LUNA Edition (${PackageInfo.version})`,
    icon: path.join(__dirname, "assets", "applogo", "icon_512x512.png"),
    frame: isMac,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  win.on("maximize", () => win.webContents.send("window-maximized-change", true));
  win.on("unmaximize", () => win.webContents.send("window-maximized-change", false));

  setLogWindow(win);
  win.on("closed", () => setLogWindow(null));

  win.on("close", (event) => {
    if (!rendererIsLoading || forceCloseRequested) {
      return;
    }
    log.warn("Close requested while an action is still running");
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Cancel", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Action in progress",
      message:
        "An action is still running. Closing now may leave files in an inconsistent state.",
      detail: "Do you want to close the application anyway?",
    });
    if (choice === 1) {
      forceCloseRequested = true;
      win.destroy();
    }
  });

  win.removeMenu();
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "OrbitPS2 Manager - LUNA Edition",
          submenu: [
            {
              label: "Quit",
              accelerator: "CmdOrCtrl+Q",
              click: () => {
                app.quit();
              },
            },
          ],
        },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  const args = process.argv.slice(1);
  const serve = args.includes("--serve");

  // Safety net: catches stray console.* output from third-party code that
  // bypasses the structured logger (logger.ts). Not a duplicate — the logger
  // sends entries with a `location` field; this wrapper does not. The logger
  // also captures the original console references at module load, before this
  // patch runs, so logger entries are never double-forwarded.
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  const sendLog = (level: string, args: any[]) => {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send("main-log", {
          level,
          message: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Ignore errors during log forwarding
    }
  };

  console.log = (...args: any[]) => {
    origLog.apply(console, args);
    sendLog("INF", args);
  };
  console.error = (...args: any[]) => {
    origError.apply(console, args);
    sendLog("ERR", args);
  };
  console.warn = (...args: any[]) => {
    origWarn.apply(console, args);
    sendLog("INF", args);
  };

  log.info(
    `Launching OrbitPS2 Manager - LUNA Edition v${PackageInfo.version} (${
      serve ? "dev/serve" : "packaged"
    } mode) on ${process.platform}`
  );

  if (serve) {
    electronReloader(module);
    win.loadURL("http://localhost:4200");
    win.webContents.openDevTools();
  } else {
    win.loadFile(
      path.join(__dirname, "..", "angular", "browser", "index.html")
    );
  }
}

// Register all IPC handlers (pure side-effect, no window needed)
registerAllIpc();

// This handler needs access to local state, so it stays here
ipcMain.on("set-loading-state", (_event, isLoading: boolean) => {
  rendererIsLoading = !!isLoading;
  log.verbose(`Renderer loading state -> ${rendererIsLoading ? "busy" : "idle"}`);
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("browser-window-focus", function () {
  globalShortcut.register("CommandOrControl+R", () => {
    log.verbose("Blocked reload shortcut (Cmd/Ctrl+R)");
  });
  globalShortcut.register("F5", () => {
    log.verbose("Blocked reload shortcut (F5)");
  });
});

app.on("browser-window-blur", function () {
  globalShortcut.unregister("CommandOrControl+R");
  globalShortcut.unregister("F5");
});
