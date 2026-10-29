import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const pipePath =
  process.env.DIDA_LOCAL_MCP_PIPE ||
  (process.platform === "win32"
    ? "\\\\.\\pipe\\DitaList"
    : path.join(
        process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
        "DidaLocal",
        "DitaList.mcp.sock",
      ));

class DitaListPipeClient {
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      let buffer = "";
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        callback(value);
      };
      const timeout = setTimeout(
        () => finish(reject, new Error("连接 DitaList 超时，请确认桌面应用正在运行")),
        10000,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        try {
          const response = JSON.parse(line);
          if (response.ok) finish(resolve, response.result);
          else finish(reject, new Error(response.error || "DitaList 操作失败"));
        } catch (error) {
          finish(reject, new Error(`DitaList 返回了无效响应：${error.message}`));
        }
      });
      socket.on("error", (error) =>
        finish(
          reject,
          new Error(
            `无法连接 DitaList 本地桥接（${pipePath}）：${error.message}。请先启动 DitaList。`,
          ),
        ),
      );
      socket.on("close", () => {
        if (!settled)
          finish(reject, new Error("DitaList 本地桥接连接已关闭"));
      });
    });
  }
}

const pipe = new DitaListPipeClient();
const id = z.string().min(1).max(160).describe("任务 ID");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("日期，格式 YYYY-MM-DD");
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional()
  .describe("时间，格式 HH:mm");
const tags = z
  .array(z.string().min(1).max(200))
  .max(200)
  .optional()
  .describe("标签名称数组，不需要带 #");

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function createServer() {
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
      textResult(
        await pipe.request("tasks.list", { query, includeDeleted }),
      ),
  );

  server.registerTool(
    "dida_list_get_task",
    {
      title: "读取 DitaList 任务",
      description: "按任务 ID 读取一条本机任务。",
      inputSchema: z.object({ id }),
    },
    async ({ id: taskId }) =>
      textResult(await pipe.request("tasks.get", { id: taskId })),
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
        startDate: date.describe("开始日期"),
        dueDate: date.describe("截止日期"),
        time: time.describe("任务时间"),
        endTime: time.describe("结束时间"),
        priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        repeat: z.enum(["none", "daily", "weekdays", "weekly", "monthly", "yearly"]).optional(),
        reminder: z.enum(["none", "at-time", "5m", "15m", "30m", "1h", "1d"]).optional(),
        tags,
      }),
    },
    async (input) => textResult(await pipe.request("tasks.create", input)),
  );

  server.registerTool(
    "dida_list_update_task",
    {
      title: "修改 DitaList 任务",
      description:
        "修改一条已有任务。修改 Agent 待确认任务不会自动批准，用户仍需在 DitaList 中确认。",
      inputSchema: z.object({
        id,
        patch: z
          .object({
            title: z.string().min(1).max(10000).optional(),
            content: z.string().max(2000000).optional(),
            listId: z.string().min(1).max(160).optional(),
            startDate: date,
            dueDate: date,
            time,
            endTime: time,
            priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
            tags,
            pinned: z.boolean().optional(),
          }),
      }),
    },
    async ({ id: taskId, patch }) =>
      textResult(await pipe.request("tasks.update", { id: taskId, patch })),
  );

  server.registerTool(
    "dida_list_delete_task",
    {
      title: "删除 DitaList 任务",
      description: "将一条任务移入 DitaList 垃圾桶，可由用户恢复。",
      inputSchema: z.object({ id }),
      annotations: { destructiveHint: true },
    },
    async ({ id: taskId }) =>
      textResult(await pipe.request("tasks.delete", { id: taskId })),
  );

  return server;
}

serveStdio(createServer, {
  onerror: (error) => console.error(`[DitaList MCP] ${error.message}`),
});
