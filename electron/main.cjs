const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  Notification,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

app.setName("本地清单");
app.setAppUserModelId("local.dida.tasks");
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
let mainWindow;
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

function assertSender(event) {
  const url = event.senderFrame?.url || "";
  if (
    event.sender !== mainWindow?.webContents ||
    !url.startsWith("dida-local://app/")
  )
    throw new Error("拒绝来自未知页面的操作");
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
    title: "本地清单",
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
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
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
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });
  app.on("window-all-closed", () => {
    writeQueue.finally(() => app.quit());
  });
}
