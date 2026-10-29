const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  Notification,
  Menu,
  Tray,
  globalShortcut,
  screen,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

app.setName("DitaList");
app.setAppUserModelId("Naoko.DitaList");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dida-local",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const isolatedDirectory = process.env.DIDA_LOCAL_DATA_DIR;
if (isolatedDirectory && !path.isAbsolute(isolatedDirectory))
  throw new Error("DIDA_LOCAL_DATA_DIR 必须是绝对路径");
app.setPath(
  "userData",
  isolatedDirectory
    ? path.join(isolatedDirectory, "electron-profile")
    : path.join(app.getPath("appData"), "DidaLocal"),
);
const dataDirectory =
  isolatedDirectory || path.join(app.getPath("userData"), "data");
const databasePath = path.join(dataDirectory, "database.json");
const backupPath = path.join(dataDirectory, "database.backup.json");
const distDirectory = path.resolve(__dirname, "..", "dist");
const defaultFloatingShortcut = "CommandOrControl+Alt+Space";
let mainWindow;
let floatingWindow;
let tray;
let floatingReady = false;
let floatingRequested = false;
let activeFloatingShortcut = null;
let quitting = false;
let loaded = false;
let writeQueue = Promise.resolve();
let lastSaveError = null;
let closeApproved = false;
let closing = false;

function assertDocument(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1
  )
    throw new Error("不支持的本地数据格式");
  for (const key of [
    "tasks",
    "lists",
    "folders",
    "habits",
    "filters",
    "focusSessions",
  ]) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 200000 ||
      value[key].some(
        (item) =>
          !item || typeof item !== "object" || typeof item.id !== "string",
      )
    )
      throw new Error(`${key} 数据无效`);
  }
  if (
    !value.settings ||
    typeof value.settings !== "object" ||
    !value.lists.some((item) => item.id === "inbox")
  )
    throw new Error("本地数据缺少设置或收集箱");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024)
    throw new Error("本地数据超过 32 MB");
  return serialized;
}

async function readDocument(file) {
  const stat = await fs.stat(file);
  if (stat.size > 32 * 1024 * 1024) throw new Error("本地数据文件超过 32 MB");
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assertDocument(parsed);
  return parsed;
}

async function loadDocument() {
  await fs.mkdir(dataDirectory, { recursive: true });
  let data = null;
  try {
    data = await readDocument(databasePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      try {
        data = await readDocument(backupPath);
        // 保留损坏原件，避免恢复后的正常保存覆盖唯一诊断材料。
        const recoveryPath = path.join(
          dataDirectory,
          `database.corrupt-${Date.now()}-${randomUUID()}.json`,
        );
        await fs.copyFile(
          databasePath,
          recoveryPath,
          require("node:fs").constants.COPYFILE_EXCL,
        );
        await fs.appendFile(
          path.join(dataDirectory, "recovery.log"),
          `${new Date().toISOString()} recovered from database.backup.json; preserved ${path.basename(recoveryPath)}\n`,
          "utf8",
        );
      } catch {
        throw new Error(
          `无法读取任务文件，已停止写入以保护原数据。请先备份 ${dataDirectory} 再检查 database.json 和 database.backup.json。`,
        );
      }
    } else {
      try {
        data = await readDocument(backupPath);
      } catch (backupError) {
        if (backupError.code !== "ENOENT")
          throw new Error(
            "主数据不存在且备份损坏，已停止写入，请先备份数据目录",
          );
      }
    }
  }
  loaded = true;
  return { data, info: { kind: "desktop", path: databasePath, backupPath } };
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT")
        console.error("temporary cleanup failed", error.code);
    });
  }
}

function assertWindowSender(event, target) {
  const url = event.senderFrame?.url || "";
  if (
    event.sender !== target?.webContents ||
    !url.startsWith("dida-local://app/")
  )
    throw new Error("拒绝来自未知页面的操作");
}

function assertSender(event) {
  assertWindowSender(event, mainWindow);
}

function assertFloatingSender(event) {
  assertWindowSender(event, floatingWindow);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function placeFloatingWindow() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const [width, height] = floatingWindow.getSize();
  floatingWindow.setPosition(
    Math.round(workArea.x + workArea.width - width - 20),
    Math.round(workArea.y + workArea.height - height - 20),
  );
}

function showFloatingWindow() {
  if (!floatingWindow || floatingWindow.isDestroyed()) createFloatingWindow();
  floatingRequested = true;
  if (!floatingReady || !floatingWindow || floatingWindow.isDestroyed()) return;
  placeFloatingWindow();
  floatingWindow.show();
  floatingWindow.focus();
}

function toggleFloatingWindow() {
  if (floatingWindow?.isVisible()) {
    floatingRequested = false;
    floatingWindow.hide();
  } else {
    showFloatingWindow();
  }
}

function sendQuickAddToMain(text) {
  showMainWindow();
  const send = () => mainWindow?.webContents.send("quick-add", text);
  if (mainWindow?.webContents.isLoading())
    mainWindow.webContents.once("did-finish-load", send);
  else send();
}

function createFloatingWindow() {
  floatingReady = false;
  floatingWindow = new BrowserWindow({
    width: 390,
    height: 190,
    minWidth: 340,
    minHeight: 170,
    resizable: false,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#fff7f0",
    title: "DitaList 快速添加",
    icon: path.join(distDirectory, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  floatingWindow.once("ready-to-show", () => {
    floatingReady = true;
    if (floatingRequested) showFloatingWindow();
  });
  floatingWindow.on("closed", () => {
    floatingWindow = null;
    floatingReady = false;
    floatingRequested = false;
  });
  floatingWindow.loadURL("dida-local://app/floating.html");
}

function quitApplication() {
  quitting = true;
  tray?.destroy();
  tray = null;
  floatingWindow?.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else writeQueue.finally(() => app.quit());
}

function createTray() {
  if (process.env.DIDA_LOCAL_HEADLESS === "1" || tray) return;
  tray = new Tray(path.join(distDirectory, "icon.png"));
  tray.setToolTip("DitaList");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 DitaList", click: showMainWindow },
      { label: "快速添加任务", click: showFloatingWindow },
      { type: "separator" },
      { label: "退出 DitaList", click: quitApplication },
    ]),
  );
  tray.on("click", toggleFloatingWindow);
  tray.on("double-click", showMainWindow);
  setFloatingShortcut(defaultFloatingShortcut);
}

function setFloatingShortcut(shortcut) {
  if (process.env.DIDA_LOCAL_HEADLESS === "1") return true;
  const next = typeof shortcut === "string" ? shortcut.trim() : "";
  const previous = activeFloatingShortcut;
  if (previous) globalShortcut.unregister(previous);
  activeFloatingShortcut = null;
  if (!next) return true;
  try {
    if (!globalShortcut.register(next, showFloatingWindow)) {
      if (previous && globalShortcut.register(previous, showFloatingWindow))
        activeFloatingShortcut = previous;
      return false;
    }
    activeFloatingShortcut = next;
    return true;
  } catch {
    if (previous && globalShortcut.register(previous, showFloatingWindow))
      activeFloatingShortcut = previous;
    return false;
  }
}

function desktopShortcutPath() {
  const override = process.env.DIDA_LOCAL_DESKTOP_DIR;
  const desktop =
    override && path.isAbsolute(override) ? override : app.getPath("desktop");
  return path.join(desktop, "DitaList.lnk");
}

function desktopShortcutDetails() {
  const target = process.execPath;
  return {
    target,
    args: process.defaultApp ? JSON.stringify(app.getAppPath()) : "",
    cwd: path.dirname(target),
    description: "DitaList 本地任务管理",
    icon: path.join(distDirectory, "icon.ico"),
    iconIndex: 0,
    appUserModelId: "Naoko.DitaList",
  };
}

async function createDesktopShortcut() {
  if (process.platform !== "win32")
    throw new Error("桌面快捷方式目前只支持 Windows");
  const shortcut = desktopShortcutPath();
  await fs.mkdir(path.dirname(shortcut), { recursive: true });
  let operation = "create";
  try {
    await fs.access(shortcut);
    operation = "update";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const created = shell.writeShortcutLink(
    shortcut,
    operation,
    desktopShortcutDetails(),
  );
  if (!created) throw new Error("Windows 没有接受桌面快捷方式写入");
  return { path: shortcut };
}

function registerIpc() {
  const handle = (name, callback) =>
    ipcMain.handle(name, async (event, ...args) => {
      assertSender(event);
      return callback(...args);
    });
  handle("data:load", () => loadDocument());
  handle("data:save", async (value) => {
    if (!loaded) throw new Error("读取任务成功后才能保存");
    const serialized = assertDocument(value);
    const save = writeQueue.then(async () => {
      try {
        const previous = await readDocument(databasePath);
        await atomicWrite(backupPath, JSON.stringify(previous, null, 2));
      } catch (error) {
        if (error.code !== "ENOENT") {
          // 损坏文件已在 loadDocument 中保全；保留已有的有效备份。
          await readDocument(backupPath);
        }
      }
      await atomicWrite(databasePath, serialized);
    });
    writeQueue = save.then(
      () => {
        lastSaveError = null;
      },
      (error) => {
        lastSaveError = error;
      },
    );
    return save;
  });
  handle("data:export", async (value) => {
    assertDocument(value);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出本地清单备份",
      defaultPath: `本地清单备份-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON 备份", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await atomicWrite(
      result.filePath,
      JSON.stringify(
        {
          format: "dida-local-backup",
          exportedAt: new Date().toISOString(),
          data: value,
        },
        null,
        2,
      ),
    );
    return true;
  });
  handle("data:import", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入备份（保留现有任务）",
      properties: ["openFile"],
      filters: [{ name: "清单备份", extensions: ["json", "csv"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > 32 * 1024 * 1024)
      throw new Error("备份文件超过 32 MB");
    return fs.readFile(file, "utf8");
  });
  handle("data:reveal", async () => {
    await shell.openPath(dataDirectory);
  });
  handle("notify", (title, body) => {
    if (
      typeof title !== "string" ||
      typeof body !== "string" ||
      title.length > 200 ||
      body.length > 2000
    )
      throw new Error("通知内容无效");
    if (Notification.isSupported())
      new Notification({ title, body, silent: false }).show();
  });
  handle("settings:set-floating-shortcut", (shortcut) => {
    if (typeof shortcut !== "string" || shortcut.length > 100)
      throw new Error("快捷键格式无效");
    return setFloatingShortcut(shortcut);
  });
  handle("shortcut:get-desktop", async () => {
    try {
      await fs.access(desktopShortcutPath());
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  handle("shortcut:create-desktop", createDesktopShortcut);
  handle("shortcut:remove-desktop", async () => {
    await fs.unlink(desktopShortcutPath()).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
  ipcMain.on("window:action", (event, action) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    if (action === "minimize") mainWindow?.minimize();
    if (action === "maximize") {
      if (mainWindow?.isMaximized()) mainWindow.unmaximize();
      else mainWindow?.maximize();
    }
    if (action === "close") mainWindow?.close();
  });
  ipcMain.on("floating:show", (event) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    showFloatingWindow();
  });
  ipcMain.on("floating:close", (event) => {
    try {
      assertFloatingSender(event);
    } catch {
      return;
    }
    floatingRequested = false;
    floatingWindow?.hide();
  });
  ipcMain.on("floating:open-main", (event) => {
    try {
      assertFloatingSender(event);
    } catch {
      return;
    }
    floatingRequested = false;
    floatingWindow?.hide();
    showMainWindow();
  });
  ipcMain.on("floating:quick-add", (event, text) => {
    try {
      assertFloatingSender(event);
    } catch {
      return;
    }
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return;
    floatingRequested = false;
    floatingWindow?.hide();
    sendQuickAddToMain(text.trim());
  });
}

function createWindow() {
  closeApproved = false;
  closing = false;
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 480,
    minHeight: 500,
    backgroundColor: "#ffffff",
    title: "DitaList",
    icon: path.join(distDirectory, "icon.png"),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.webRequest.onBeforeRequest(
    (details, callback) =>
      callback({
        cancel:
          !details.url.startsWith("dida-local://app/") &&
          !details.url.startsWith("devtools://") &&
          !details.url.startsWith("data:") &&
          !details.url.startsWith("blob:"),
      }),
  );
  mainWindow.once("ready-to-show", () => {
    if (process.env.DIDA_LOCAL_HEADLESS !== "1") mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (closeApproved) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void writeQueue.then(async () => {
      if (lastSaveError) {
        const result = await dialog.showMessageBox(mainWindow, {
          type: "error",
          title: "本地数据尚未保存",
          message: "最后一次保存失败，请返回应用导出备份或重试保存。",
          detail: String(lastSaveError.message || lastSaveError),
          buttons: ["返回应用", "退出并放弃未保存改动"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) {
          closing = false;
          return;
        }
      }
      closeApproved = true;
      mainWindow?.close();
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL("dida-local://app/index.html");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    showMainWindow();
  });
  app
    .whenReady()
    .then(async () => {
      const mime = {
        ".html": "text/html;charset=utf-8",
        ".js": "text/javascript;charset=utf-8",
        ".css": "text/css;charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      protocol.handle("dida-local", async (request) => {
        try {
          const url = new URL(request.url);
          const target = path.resolve(
            distDirectory,
            `.${decodeURIComponent(url.pathname)}`,
          );
          if (
            request.method !== "GET" ||
            url.hostname !== "app" ||
            (target !== distDirectory &&
              !target.startsWith(distDirectory + path.sep))
          )
            return new Response("Forbidden", { status: 403 });
          const file =
            target === distDirectory ? path.join(target, "index.html") : target;
          return new Response(await fs.readFile(file), {
            headers: {
              "content-type":
                mime[path.extname(file)] || "application/octet-stream",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      registerIpc();
      createWindow();
      createTray();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
  });
  app.on("window-all-closed", () => {
    if (process.platform === "win32" && tray && !quitting) return;
    writeQueue.finally(() => app.quit());
  });
}
