import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  protocol,
  net,
  session,
  clipboard,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DropBridgeService } from "../server/service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devURL = process.env.DROPBRIDGE_DEV_URL;
const smoke = process.env.DROPBRIDGE_SMOKE === "1";
if (process.env.DROPBRIDGE_DATA_DIR)
  app.setPath("userData", process.env.DROPBRIDGE_DATA_DIR);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dropbridge",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setAppUserModelId("local.dropbridge.desktop");
const lock = app.requestSingleInstanceLock();
let window,
  service,
  quitting = false;
if (!lock) app.quit();
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

async function createWindow() {
  window = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 920,
    minHeight: 650,
    show: false,
    backgroundColor: "#101216",
    title: "DropBridge",
    icon: path.join(root, "build/icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== (devURL || "dropbridge://app/")) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => {
    if (!smoke) window.show();
  });
  await window.loadURL(devURL || "dropbridge://app/");
  if (smoke) {
    setTimeout(async () => {
      try {
        const state = await window.webContents.executeJavaScript(
          'window.dropbridge.invoke("state")',
        );
        const shot = await window.webContents.capturePage();
        const fs = await import("node:fs/promises");
        if (process.env.DROPBRIDGE_SCREENSHOT)
          await fs.writeFile(process.env.DROPBRIDGE_SCREENSHOT, shot.toPNG());
        console.log(
          "SMOKE",
          JSON.stringify({
            running: state.running,
            url: state.url,
            bridge: true,
          }),
        );
        app.quit();
      } catch (e) {
        console.error(e);
        app.exit(1);
      }
    }, 2000);
  }
}

if (lock)
  app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, cb) => cb(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      protocol.handle("dropbridge", (request) => {
        const url = new URL(request.url);
        let pathname;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const target = path.resolve(
          root,
          "dist",
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
        if (
          url.host !== "app" ||
          pathname.includes("..") ||
          pathname.includes("\\") ||
          !target.startsWith(path.join(root, "dist") + path.sep)
        )
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(target).toString()).then((response) => {
          const headers = new Headers(response.headers);
          headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          );
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        });
      });
      service = await new DropBridgeService({
        dataDir: app.getPath("userData"),
        receiveDir:
          process.env.DROPBRIDGE_RECEIVE_DIR ||
          path.join(app.getPath("downloads"), "DropBridge"),
        webDir: path.join(root, "dist"),
      }).init();
      service.on("state", (state) => {
        if (window && !window.isDestroyed())
          window.webContents.send("dropbridge:state", state);
      });
      service.on("diagnostic", (message) =>
        console.error("[DropBridge]", message),
      );
      service.on("received", (transfer) => {
        if (service.settings.notifications && Notification.isSupported())
          new Notification({
            title: "File received",
            body: `${transfer.name} from ${transfer.device}`,
          }).show();
      });
      ipcMain.handle("dropbridge:action", async (event, action, payload) => {
        const frame = event.senderFrame;
        if (
          event.sender !== window?.webContents ||
          !frame ||
          frame !== window.webContents.mainFrame ||
          !frame.url.startsWith(devURL || "dropbridge://app/")
        )
          throw new Error("Untrusted sender");
        try {
          switch (action) {
            case "state":
              return service.desktopState();
            case "copyAddress":
              clipboard.writeText(service.url || "");
              break;
            case "storage":
              return await service.storage();
            case "start":
              await service.start();
              break;
            case "stop":
              await service.stop();
              break;
            case "rotate":
              await service.rotatePairing();
              break;
            case "approve":
              await service.approvePairing(payload.id, payload.accept === true);
              break;
            case "revoke":
              await service.revokeDevice(payload);
              break;
            case "approveUpload":
              await service.approveUpload(payload);
              break;
            case "cancel":
              await service.cancelUpload(payload);
              break;
            case "removeShare":
              await service.removeShare(payload);
              break;
            case "clearHistory":
              await service.clearHistory();
              break;
            case "addFiles":
              await service.addShares(payload);
              break;
            case "chooseFiles": {
              const picked = await dialog.showOpenDialog(window, {
                title: "Share files with your devices",
                properties: ["openFile", "multiSelections"],
              });
              if (!picked.canceled) await service.addShares(picked.filePaths);
              break;
            }
            case "chooseFolder": {
              const picked = await dialog.showOpenDialog(window, {
                title: "Choose receiving folder",
                properties: ["openDirectory", "createDirectory"],
              });
              if (!picked.canceled)
                await service.updateSettings({
                  receiveDir: picked.filePaths[0],
                });
              break;
            }
            case "settings": {
              const { receiveDir: _ignored, ...settings } = payload;
              if ("launchAtLogin" in settings && !app.isPackaged)
                throw new Error(
                  "Launch with Windows is available in the packaged app.",
                );
              await service.updateSettings(settings);
              if ("launchAtLogin" in settings)
                app.setLoginItemSettings({
                  openAtLogin: service.settings.launchAtLogin,
                  path:
                    process.env.PORTABLE_EXECUTABLE_FILE || app.getPath("exe"),
                });
              break;
            }
            case "open": {
              const filename = service.knownPath(payload.id, payload.kind);
              const ext = path.extname(filename).toLowerCase();
              if (
                [
                  ".exe",
                  ".msi",
                  ".bat",
                  ".cmd",
                  ".ps1",
                  ".vbs",
                  ".js",
                  ".lnk",
                  ".scr",
                  ".com",
                  ".reg",
                  ".hta",
                  ".url",
                ].includes(ext)
              ) {
                shell.showItemInFolder(filename);
                break;
              }
              const error = await shell.openPath(filename);
              if (error) throw new Error(error);
              break;
            }
            case "reveal":
              shell.showItemInFolder(
                service.knownPath(payload.id, payload.kind),
              );
              break;
            case "openFolder": {
              const error = await shell.openPath(service.settings.receiveDir);
              if (error) throw new Error(error);
              break;
            }
            default:
              throw new Error("Unknown action");
          }
          return service.desktopState();
        } catch (error) {
          throw new Error(error.message || "Operation failed");
        }
      });
      await service.start();
      await createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox("DropBridge could not start", error.message);
      app.quit();
    });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  service.stop().finally(() => app.quit());
});
