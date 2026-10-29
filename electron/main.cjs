const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  clipboard,
  Notification,
  Menu,
  Tray,
  globalShortcut,
  screen,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { McpServer, createMcpHandler } = require("@modelcontextprotocol/server");
const { z } = require("zod");

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
const mcpPipePath =
  process.env.DIDA_LOCAL_MCP_PIPE ||
  (process.platform === "win32"
    ? "\\\\.\\pipe\\DitaList"
    : path.join(dataDirectory, "DitaList.mcp.sock"));
const defaultFloatingShortcut = "CommandOrControl+Alt+Space";
let mainWindow;
let floatingWindow;
let tray;
let floatingReady = false;
let floatingRequested = false;
let activeFloatingShortcut = null;
let quitting = false;
let mcpBridge;
let mcpHttpServer;
let mcpHttpUrl = `http://127.0.0.1:${process.env.DIDA_LOCAL_MCP_PORT || 27182}/mcp`;
let mcpRequestQueue = Promise.resolve();
let currentDocument = null;
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
  await writeQueue.catch(() => {});
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
  currentDocument = data;
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

function cloneDocument(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function notifyExternalData(reason, taskIds = []) {
  if (!currentDocument || !mainWindow || mainWindow.isDestroyed()) return;
  const send = () =>
    mainWindow?.webContents.send("external-data-change", {
      data: cloneDocument(currentDocument),
      reason,
      taskIds,
    });
  if (mainWindow.webContents.isLoading())
    mainWindow.webContents.once("did-finish-load", send);
  else send();
}

function enqueueDocumentSave(value) {
  if (!loaded) throw new Error("读取任务成功后才能保存");
  const serialized = assertDocument(value);
  currentDocument = JSON.parse(serialized);
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

function mcpText(value, label, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}无效`);
  return value.trim();
}

function mcpList(data, listId) {
  const id = typeof listId === "string" && listId ? listId : "inbox";
  const list = data.lists.find((item) => item.id === id && !item.archived);
  if (!list) throw new Error("目标清单不存在或已归档");
  return list;
}

function mcpDate(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("日期必须是 YYYY-MM-DD");
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error("日期无效");
  return value;
}

function mcpTime(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error("时间必须是 HH:mm");
  return value;
}

function createAgentTask(data, input) {
  const title = mcpText(input.title, "任务标题");
  const list = mcpList(data, input.listId);
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title,
    content: typeof input.content === "string" ? input.content.slice(0, 2000000) : "",
    listId: list.id,
    startDate: mcpDate(input.startDate),
    dueDate: mcpDate(input.dueDate),
    time: mcpTime(input.time),
    endTime: mcpTime(input.endTime),
    priority: [0, 1, 2, 3].includes(input.priority) ? input.priority : 0,
    repeat: ["none", "daily", "weekdays", "weekly", "monthly", "yearly"].includes(input.repeat)
      ? input.repeat
      : "none",
    reminder: ["none", "at-time", "5m", "15m", "30m", "1h", "1d"].includes(input.reminder)
      ? input.reminder
      : "none",
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 200)
      : [],
    subtasks: [],
    completedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    sortOrder: Math.max(0, ...data.tasks.map((item) => item.sortOrder)) + 1,
    pinned: false,
    createdBy: "agent",
    agentStatus: "pending",
  };
  if (task.startDate && task.dueDate && task.startDate > task.dueDate)
    throw new Error("开始日期不能晚于结束日期");
  return task;
}

async function currentMcpDocument() {
  if (currentDocument) return cloneDocument(currentDocument);
  const loadedDocument = await loadDocument();
  if (!loadedDocument.data)
    throw new Error("DitaList 尚未完成首次数据初始化，请先打开主窗口");
  return cloneDocument(loadedDocument.data);
}

function queueMcpRequest(method, params) {
  const request = mcpRequestQueue.then(() => handleMcpRequest(method, params));
  mcpRequestQueue = request.catch(() => {});
  return request;
}

async function handleMcpRequest(method, params = {}) {
  if (method === "data.save") {
    await enqueueDocumentSave(params);
    return null;
  }
  const data = await currentMcpDocument();
  if (method === "tasks.list") {
    const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    const includeDeleted = params.includeDeleted === true;
    const tasks = data.tasks.filter((task) => {
      if (!includeDeleted && task.deletedAt) return false;
      if (!query) return true;
      return `${task.title} ${task.content} ${task.tags.join(" ")}`.toLowerCase().includes(query);
    });
    return { tasks, pendingAgentTaskIds: tasks.filter((task) => task.createdBy === "agent" && task.agentStatus === "pending").map((task) => task.id) };
  }
  if (method === "tasks.get") {
    const id = mcpText(params.id, "任务 ID", 160);
    const task = data.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在");
    return { task };
  }
  if (method === "tasks.create") {
    const task = createAgentTask(data, params);
    data.tasks.push(task);
    await enqueueDocumentSave(data);
    notifyExternalData("agent-task-created", [task.id]);
    return { task, needsApproval: true };
  }
  if (method === "tasks.update") {
    const id = mcpText(params.id, "任务 ID", 160);
    const task = data.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在");
    const patch = params.patch && typeof params.patch === "object" ? params.patch : {};
    const next = { ...task };
    if (patch.title !== undefined) next.title = mcpText(patch.title, "任务标题");
    if (patch.content !== undefined) next.content = String(patch.content).slice(0, 2000000);
    if (patch.listId !== undefined) next.listId = mcpList(data, patch.listId).id;
    if (patch.startDate !== undefined) next.startDate = mcpDate(patch.startDate);
    if (patch.dueDate !== undefined) next.dueDate = mcpDate(patch.dueDate);
    if (patch.time !== undefined) next.time = mcpTime(patch.time);
    if (patch.endTime !== undefined) next.endTime = mcpTime(patch.endTime);
    if (patch.priority !== undefined && [0, 1, 2, 3].includes(patch.priority)) next.priority = patch.priority;
    if (patch.tags !== undefined && Array.isArray(patch.tags)) next.tags = [...new Set(patch.tags.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 200);
    if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
    if (next.startDate && next.dueDate && next.startDate > next.dueDate) throw new Error("开始日期不能晚于结束日期");
    next.updatedAt = new Date().toISOString();
    data.tasks = data.tasks.map((item) => (item.id === id ? next : item));
    await enqueueDocumentSave(data);
    notifyExternalData("agent-task-updated", [id]);
    return { task: next, applied: true };
  }
  if (method === "tasks.delete") {
    const id = mcpText(params.id, "任务 ID", 160);
    const task = data.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在");
    task.deletedAt = new Date().toISOString();
    task.updatedAt = task.deletedAt;
    await enqueueDocumentSave(data);
    notifyExternalData("agent-task-deleted", [id]);
    return { task, applied: true };
  }
  throw new Error(`未知 MCP 操作：${method}`);
}

const mcpIdSchema = z.string().min(1).max(160).describe("任务 ID");
const mcpDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("日期，格式 YYYY-MM-DD");
const mcpTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional()
  .describe("时间，格式 HH:mm");
const mcpTagsSchema = z
  .array(z.string().min(1).max(200))
  .max(200)
  .optional()
  .describe("标签名称数组，不需要带 #");

function mcpTextResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function createEmbeddedMcpServer() {
  const server = new McpServer({
    name: "ditalist-local",
    version: "0.1.0",
  });
  server.registerTool(
    "dida_list_list_tasks",
    {
      title: "查询 DitaList 任务",
      description:
        "查询本机 DitaList 的任务。结果中的 createdBy=agent 表示 Agent 创建，agentStatus=pending 表示仍等待用户在 DitaList 中确认。",
      inputSchema: z.object({
        query: z.string().max(2000).optional().describe("按标题、描述或标签搜索"),
        includeDeleted: z.boolean().optional().describe("是否包含垃圾桶任务"),
      }),
    },
    async ({ query, includeDeleted }) =>
      mcpTextResult(await queueMcpRequest("tasks.list", { query, includeDeleted })),
  );
  server.registerTool(
    "dida_list_get_task",
    {
      title: "读取 DitaList 任务",
      description: "按任务 ID 读取一条本机任务。",
      inputSchema: z.object({ id: mcpIdSchema }),
    },
    async ({ id }) =>
      mcpTextResult(await queueMcpRequest("tasks.get", { id })),
  );
  server.registerTool(
    "dida_list_create_task",
    {
      title: "创建 DitaList 任务",
      description:
        "在 DitaList 中创建一条 Agent 任务。任务会显示 Agent 标记，并在用户批准前保持待确认状态；创建不会直接执行完成或提醒。",
      inputSchema: z.object({
        title: z.string().min(1).max(10000).describe("任务标题"),
        content: z.string().max(2000000).optional().describe("任务描述"),
        listId: z.string().min(1).max(160).optional().describe("清单 ID，默认 inbox"),
        startDate: mcpDateSchema.describe("开始日期"),
        dueDate: mcpDateSchema.describe("截止日期"),
        time: mcpTimeSchema.describe("任务时间"),
        endTime: mcpTimeSchema.describe("结束时间"),
        priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        repeat: z.enum(["none", "daily", "weekdays", "weekly", "monthly", "yearly"]).optional(),
        reminder: z.enum(["none", "at-time", "5m", "15m", "30m", "1h", "1d"]).optional(),
        tags: mcpTagsSchema,
      }),
    },
    async (input) =>
      mcpTextResult(await queueMcpRequest("tasks.create", input)),
  );
  server.registerTool(
    "dida_list_update_task",
    {
      title: "修改 DitaList 任务",
      description:
        "修改一条已有任务。修改 Agent 待确认任务不会自动批准，用户仍需在 DitaList 中确认。",
      inputSchema: z.object({
        id: mcpIdSchema,
        patch: z
          .object({
            title: z.string().min(1).max(10000).optional(),
            content: z.string().max(2000000).optional(),
            listId: z.string().min(1).max(160).optional(),
            startDate: mcpDateSchema,
            dueDate: mcpDateSchema,
            time: mcpTimeSchema,
            endTime: mcpTimeSchema,
            priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
            tags: mcpTagsSchema,
            pinned: z.boolean().optional(),
          }),
      }),
    },
    async ({ id, patch }) =>
      mcpTextResult(await queueMcpRequest("tasks.update", { id, patch })),
  );
  server.registerTool(
    "dida_list_delete_task",
    {
      title: "删除 DitaList 任务",
      description: "将一条任务移入 DitaList 垃圾桶，可由用户恢复。",
      inputSchema: z.object({ id: mcpIdSchema }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) =>
      mcpTextResult(await queueMcpRequest("tasks.delete", { id })),
  );
  return server;
}

const mcpHttpHandler = createMcpHandler(createEmbeddedMcpServer);

function startMcpBridge() {
  if (!mcpBridge) {
    mcpBridge = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) {
          socket.destroy(new Error("MCP 请求超过 1 MB"));
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          void (async () => {
            let request;
            try {
              request = JSON.parse(line);
              const result = await queueMcpRequest(request.method, request.params || {});
              socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
            } catch (error) {
              socket.write(`${JSON.stringify({ id: request?.id ?? null, ok: false, error: String(error?.message || error) })}\n`);
            }
          })();
        }
      });
    });
    mcpBridge.on("error", (error) => console.error("MCP bridge error", error));
    const listen = () => mcpBridge.listen(mcpPipePath, () => console.error(`DitaList MCP bridge ready: ${mcpPipePath}`));
    if (process.platform !== "win32") {
      void fs.mkdir(path.dirname(mcpPipePath), { recursive: true }).then(async () => {
        await fs.unlink(mcpPipePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        listen();
      }).catch((error) => console.error("MCP bridge setup error", error));
    } else {
      listen();
    }
  }
  if (!mcpHttpServer) {
    const preferredPort = process.env.DIDA_LOCAL_MCP_PORT
      ? Number(process.env.DIDA_LOCAL_MCP_PORT)
      : process.env.DIDA_LOCAL_HEADLESS === "1"
        ? 0
        : 27182;
    mcpHttpServer = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuffer = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
          else if (v !== undefined) headers.set(k, v);
        }
        const url = new URL(
          req.url || "/mcp",
          `http://${req.headers.host || "127.0.0.1:27182"}`,
        );
        const webReq = new Request(url, {
          method: req.method || "GET",
          headers,
          body: ["GET", "HEAD"].includes(req.method || "GET")
            ? undefined
            : bodyBuffer,
        });
        const webRes = await mcpHttpHandler.fetch(webReq);
        res.statusCode = webRes.status;
        webRes.headers.forEach((value, key) => res.setHeader(key, value));
        if (webRes.body) {
          for await (const chunk of webRes.body) res.write(chunk);
        }
        res.end();
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      }
    });
    mcpHttpServer.on("error", (error) =>
      console.error("MCP HTTP server error", error),
    );
    mcpHttpServer.listen(preferredPort, "127.0.0.1", () => {
      const addr = mcpHttpServer.address();
      if (addr && typeof addr === "object") {
        mcpHttpUrl = `http://127.0.0.1:${addr.port}/mcp`;
        console.error(`DitaList MCP HTTP ready: ${mcpHttpUrl}`);
      }
    });
  }
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
  tray = new Tray(
    path.join(distDirectory, process.platform === "win32" ? "icon.ico" : "icon.png"),
  );
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

const agentDocumentDirectory = path.join(dataDirectory, "agent");
const agentDocumentPath = path.join(agentDocumentDirectory, "DitaList-Agent.md");
const mcpServerPath = path.resolve(__dirname, "..", "mcp", "server.mjs");

function agentDocumentContent() {
  const httpConfig = {
    mcpServers: {
      ditalist: {
        type: "streamable-http",
        url: mcpHttpUrl,
      },
    },
  };
  const embeddedConfig = {
    mcpServers: {
      ditalist: {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.env.DIDA_LOCAL_MCP_PIPE
            ? { DIDA_LOCAL_MCP_PIPE: mcpPipePath }
            : {}),
        },
      },
    },
  };
  return `# DitaList 本地 Agent / MCP 配置说明

> 本文档由 DitaList 自动生成，保存在本地数据目录中，随时可在「设置 → Agent / MCP」中查看、复制或重新生成。
> DitaList 启动后已直接在本机内置运行 MCP 服务，**Agent 框架只需直接填写下方 MCP 插件链接即可连接**，无需额外配置 Node 环境。

## 1. MCP 插件链接（推荐：直接填写此 URL 即可）

- **MCP 插件链接（Streamable HTTP）**：\`${mcpHttpUrl}\`

## 2. 不同 Agent 框架的一键接入方式

### 方式 A：支持填写 MCP 链接的客户端（Cursor / Cherry Studio / Claude / Dify 等）

直接填入上方 URL，或写入：

\`\`\`json
${JSON.stringify(httpConfig, null, 2)}
\`\`\`

### 方式 B：DeepSeek Harness (DSH) 配置（无需探索，直接写入 \`~/.dsh/profiles/desktop/cordis.patch.yml\`）

\`\`\`yaml
- id: mcp-ditalist
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: ditalist
    transport: streamable-http
    url: ${mcpHttpUrl}
\`\`\`

### 方式 C：仅支持 Stdio 的客户端（使用 DitaList 内置运行时，无需安装 Node.js）

\`\`\`json
${JSON.stringify(embeddedConfig, null, 2)}
\`\`\`

## 3. MCP 工具与安全确认机制

DitaList 采用「规划与执行分离、本机前置审批」机制，所有数据仅保存在本机：

- \`dida_list_list_tasks\`：查询本机任务（支持 \`query\` 关键词搜索与 \`includeDeleted\` 参数），返回结果包含 \`createdBy\` 与 \`agentStatus\`。
- \`dida_list_get_task\`：按任务 \`id\` 读取单条任务详情。
- \`dida_list_create_task\`：创建 Agent 规划任务（支持标题、描述、清单 \`listId\`、起止日期、时间、优先级、重复规则、提醒、标签）。新建任务会标记为 \`createdBy: "agent"\` 且 \`agentStatus: "pending"\`，在 DitaList 界面弹窗等待用户单条或批量确认。
- \`dida_list_update_task\`：按 \`id\` 修改任务字段（修改待确认任务不会跳过用户确认）。
- \`dida_list_delete_task\`：按 \`id\` 将任务移入垃圾桶，用户可在垃圾桶恢复。

## 4. 本机路径信息

- **MCP HTTP 地址**：\`${mcpHttpUrl}\`
- **本地 IPC 管道地址**：\`${mcpPipePath}\`
- **DitaList 数据目录**：\`${dataDirectory}\`
- **说明文档路径**：\`${agentDocumentPath}\`
`;
}

async function generateAgentDocument() {
  await fs.mkdir(agentDocumentDirectory, { recursive: true });
  const content = agentDocumentContent();
  await atomicWrite(agentDocumentPath, content);
  return {
    path: agentDocumentPath,
    directory: agentDocumentDirectory,
    mcpServerPath,
    pipePath: mcpPipePath,
    httpUrl: mcpHttpUrl,
    content,
  };
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
  handle("data:save", (value) => enqueueDocumentSave(value));
  handle("data:export", async (value) => {
    assertDocument(value);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出 DitaList 备份",
      defaultPath: `DitaList-备份-${new Date().toISOString().slice(0, 10)}.json`,
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
  handle("agent:generate-document", generateAgentDocument);
  handle("agent:copy-document", async () => {
    const document = await generateAgentDocument();
    clipboard.writeText(document.content);
    return { path: document.path, copied: true };
  });
  handle("agent:open-directory", async () => {
    await fs.mkdir(agentDocumentDirectory, { recursive: true });
    const error = await shell.openPath(agentDocumentDirectory);
    if (error) throw new Error(error);
    return { path: agentDocumentDirectory };
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
      startMcpBridge();
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
    mcpBridge?.close();
    mcpBridge = null;
    mcpHttpServer?.close();
    mcpHttpServer = null;
    void mcpHttpHandler.close().catch(() => {});
  });
  app.on("window-all-closed", () => {
    if (process.platform === "win32" && tray && !quitting) return;
    writeQueue.finally(() => app.quit());
  });
}
