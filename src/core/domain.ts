import { z } from "zod";
import type { AppData, RepeatRule, Task, ViewId } from "../model";

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateObject(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function addDays(date: string, count: number): string {
  const result = dateObject(date);
  result.setDate(result.getDate() + count);
  return localDate(result);
}

function isDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && localDate(dateObject(value)) === value
  );
}

const dateSchema = z.string().refine(isDate, "日期必须是有效的 YYYY-MM-DD");
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须是 HH:mm");
const timestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "时间戳无效");
const idSchema = z.string().min(1).max(160);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const viewSchema = z
  .string()
  .refine(
    (value) =>
      [
        "today",
        "next7",
        "inbox",
        "all",
        "calendar",
        "matrix",
        "focus",
        "habits",
        "completed",
        "trash",
      ].includes(value) || /^(list|tag|filter):.+$/.test(value),
  )
  .transform((value) => value as ViewId);

const taskSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(10000),
    content: z.string().max(2000000),
    listId: idSchema,
    startDate: dateSchema.nullable(),
    dueDate: dateSchema.nullable(),
    time: timeSchema.nullable(),
    endTime: timeSchema.nullable(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    repeat: z.enum([
      "none",
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "yearly",
    ]),
    reminder: z.enum(["none", "at-time", "5m", "15m", "30m", "1h", "1d"]),
    tags: z.array(z.string().trim().min(1).max(200)).max(200),
    subtasks: z
      .array(
        z.object({
          id: idSchema,
          title: z.string().max(10000),
          completed: z.boolean(),
        }),
      )
      .max(10000),
    completedAt: timestampSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    sortOrder: z.number().finite(),
    pinned: z.boolean(),
    createdBy: z.enum(["user", "agent"]).default("user"),
    agentStatus: z.enum(["pending", "approved"]).default("approved"),
    recurrenceAnchor: dateSchema.optional(),
    recurrenceId: idSchema.optional(),
  })
  .refine(
    (task) =>
      !task.startDate || !task.dueDate || task.startDate <= task.dueDate,
    "开始日期不能晚于结束日期",
  );

const appSchema = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(taskSchema).max(200000),
  lists: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(500),
        color: colorSchema,
        folderId: idSchema.nullable(),
        archived: z.boolean(),
        sortOrder: z.number().finite(),
      }),
    )
    .max(10000),
  folders: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(500),
        sortOrder: z.number().finite(),
      }),
    )
    .max(10000),
  habits: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(500),
        icon: z.string().max(100),
        color: colorSchema,
        goal: z.number().int().min(1).max(1000000),
        days: z.array(z.number().int().min(0).max(6)).max(7),
        records: z.record(dateSchema, z.number().int().min(0).max(1000000)),
        createdAt: timestampSchema,
      }),
    )
    .max(10000),
  filters: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(500),
        query: z.string().max(10000),
        color: colorSchema,
      }),
    )
    .max(10000),
  focusSessions: z
    .array(
      z.object({
        id: idSchema,
        taskId: idSchema.nullable(),
        title: z.string().max(10000),
        startedAt: timestampSchema,
        endedAt: timestampSchema,
        durationSeconds: z.number().int().min(0).max(604800),
        completed: z.boolean(),
      }),
    )
    .max(200000),
  settings: z.object({
    theme: z.enum(["light", "dark", "system"]),
    accent: colorSchema,
    weekStart: z.union([z.literal(0), z.literal(1)]),
    showCompleted: z.boolean(),
    calendarMode: z.enum(["month", "week", "day", "agenda"]),
    sidebarCollapsed: z.boolean(),
    defaultView: viewSchema,
    pomodoroMinutes: z.number().int().min(1).max(180),
    breakMinutes: z.number().int().min(1).max(60),
    sound: z.boolean(),
    notifications: z.boolean(),
    floatingShortcut: z.string().trim().max(100).default("CommandOrControl+Alt+Space"),
    floatingDefaultListId: idSchema.default("inbox"),
    floatingDefaultDate: z.enum(["none", "today", "tomorrow"]).default("today"),
    customTags: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  }),
});

export function validateData(value: unknown): AppData {
  const result = appSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `数据格式不正确（${issue.path.join(".") || "根对象"}）：${issue.message}`,
    );
  }
  const data = result.data;
  for (const key of [
    "tasks",
    "lists",
    "folders",
    "habits",
    "filters",
    "focusSessions",
  ] as const) {
    const ids = data[key].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      throw new Error(`数据中存在重复的 ${key} ID`);
  }
  const listIds = new Set(data.lists.map((item) => item.id));
  const folderIds = new Set(data.folders.map((item) => item.id));
  if (!listIds.has("inbox")) throw new Error("数据缺少收集箱");
  if (
    !listIds.has(data.settings.floatingDefaultListId) ||
    data.lists.find((item) => item.id === data.settings.floatingDefaultListId)
      ?.archived
  )
    data.settings.floatingDefaultListId = "inbox";
  if (data.tasks.some((task) => !listIds.has(task.listId)))
    throw new Error("任务引用了不存在的清单");
  if (data.lists.some((list) => list.folderId && !folderIds.has(list.folderId)))
    throw new Error("清单引用了不存在的文件夹");
  for (const task of data.tasks) {
    if (
      new Set(task.subtasks.map((item) => item.id)).size !==
      task.subtasks.length
    )
      throw new Error("任务中存在重复的子任务 ID");
  }
  return data;
}

export function createEmptyData(): AppData {
  return {
    schemaVersion: 1,
    tasks: [],
    lists: [
      {
        id: "inbox",
        name: "收集箱",
        color: "#4772FA",
        folderId: null,
        archived: false,
        sortOrder: 0,
      },
    ],
    folders: [],
    habits: [],
    filters: [],
    focusSessions: [],
    settings: {
      theme: "light",
      accent: "#4772FA",
      weekStart: 1,
      showCompleted: false,
      calendarMode: "month",
      sidebarCollapsed: false,
      defaultView: "today",
      pomodoroMinutes: 25,
      breakMinutes: 5,
      sound: true,
      notifications: true,
      floatingShortcut: "CommandOrControl+Alt+Space",
      floatingDefaultListId: "inbox",
      floatingDefaultDate: "today",
      customTags: [],
    },
  };
}

export function createTask(
  input: Partial<Task> & { title: string },
  now = new Date(),
): Task {
  const stamp = now.toISOString();
  const value = {
    id: crypto.randomUUID(),
    content: "",
    listId: "inbox",
    startDate: null,
    dueDate: null,
    time: null,
    endTime: null,
    priority: 0,
    repeat: "none",
    reminder: "none",
    tags: [],
    subtasks: [],
    completedAt: null,
    deletedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    sortOrder: now.getTime(),
    pinned: false,
    createdBy: "user",
    agentStatus: "approved",
    ...input,
  };
  const result = taskSchema.safeParse(value);
  if (!result.success)
    throw new Error(`任务格式不正确：${result.error.issues[0].message}`);
  return result.data;
}

export function nextRecurringDate(
  date: string,
  rule: RepeatRule,
  anchor = date,
): string {
  const current = dateObject(date);
  const original = dateObject(anchor);
  if (rule === "daily") return addDays(date, 1);
  if (rule === "weekly") return addDays(date, 7);
  if (rule === "weekdays") {
    do {
      current.setDate(current.getDate() + 1);
    } while (current.getDay() === 0 || current.getDay() === 6);
    return localDate(current);
  }
  if (rule === "monthly") {
    const month = current.getMonth() + 1;
    const year = current.getFullYear();
    const lastDay = new Date(year, month + 1, 0).getDate();
    return localDate(
      new Date(year, month, Math.min(original.getDate(), lastDay), 12),
    );
  }
  if (rule === "yearly") {
    const year = current.getFullYear() + 1;
    const month = original.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();
    return localDate(
      new Date(year, month, Math.min(original.getDate(), lastDay), 12),
    );
  }
  return date;
}

export function completeTask(
  data: AppData,
  id: string,
  now = new Date(),
): AppData {
  const task = data.tasks.find((item) => item.id === id);
  if (!task || task.deletedAt || task.completedAt) return data;
  const stamp = now.toISOString();
  const recurring = task as Task & {
    recurrenceAnchor?: string;
    recurrenceId?: string;
  };
  const anchor = recurring.recurrenceAnchor || task.dueDate || localDate(now);
  const series = recurring.recurrenceId || task.id;
  const completed = {
    ...task,
    agentStatus: "approved" as const,
    completedAt: stamp,
    updatedAt: stamp,
    ...(task.repeat !== "none"
      ? { recurrenceAnchor: anchor, recurrenceId: series }
      : {}),
  };
  const tasks = data.tasks.map((item) => (item.id === id ? completed : item));
  if (task.repeat !== "none") {
    const nextDate = nextRecurringDate(
      task.dueDate || localDate(now),
      task.repeat,
      anchor,
    );
    const alreadyExists = tasks.some(
      (item) =>
        (item as typeof recurring).recurrenceId === series &&
        item.dueDate === nextDate &&
        !item.deletedAt,
    );
    if (!alreadyExists) {
      const offset =
        task.startDate && task.dueDate
          ? Math.round(
              (dateObject(task.dueDate).getTime() -
                dateObject(task.startDate).getTime()) /
                86400000,
            )
          : 0;
      tasks.push(
        createTask(
          {
            ...task,
            id: crypto.randomUUID(),
            dueDate: nextDate,
            startDate: task.startDate ? addDays(nextDate, -offset) : null,
            completedAt: null,
            deletedAt: null,
            subtasks: task.subtasks.map((item) => ({
              ...item,
              id: crypto.randomUUID(),
              completed: false,
            })),
            recurrenceAnchor: anchor,
            recurrenceId: series,
            createdAt: stamp,
            updatedAt: stamp,
          } as Partial<Task> & { title: string },
          now,
        ),
      );
    }
  }
  return { ...data, tasks };
}

export function parseQuickInput(
  text: string,
  defaultListId = "inbox",
  today = localDate(),
): Partial<Task> & { title: string } {
  let title = text.trim();
  const result: Partial<Task> & { title: string } = {
    title,
    listId: defaultListId,
  };
  const tags: string[] = [];
  title = title.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu, (_, tag: string) => {
    tags.push(tag);
    return " ";
  });
  if (tags.length) result.tags = [...new Set(tags)];
  title = title.replace(/(?:^|\s)![123](?=\s|$)/, (match) => {
    result.priority = Number(match.trim().slice(1)) as Task["priority"];
    return " ";
  });
  title = title.replace(/每天|每周|每月|每年|每个工作日|工作日/, (token) => {
    result.repeat = token.includes("工作日")
      ? "weekdays"
      : (
          {
            每天: "daily",
            每周: "weekly",
            每月: "monthly",
            每年: "yearly",
          } as Record<string, RepeatRule>
        )[token];
    result.dueDate = today;
    return "";
  });
  title = title.replace(/大后天|后天|明天|今天/, (token) => {
    result.dueDate = addDays(
      today,
      ({ 今天: 0, 明天: 1, 后天: 2, 大后天: 3 } as Record<string, number>)[
        token
      ],
    );
    return "";
  });
  title = title.replace(
    /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/,
    (token, year, month, day) => {
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!isDate(date)) return token;
      result.dueDate = date;
      return "";
    },
  );
  title = title.replace(
    /(上午|下午|晚上|早上|中午)?\s*(\d{1,2})[:：](\d{2})|(?:上午|下午|晚上|早上|中午)\s*\d{1,2}点(?:半|\d{1,2}分?)?/,
    (token) => {
      const match = token.match(
        /(上午|下午|晚上|早上|中午)?\s*(\d{1,2})(?:[:：](\d{2})|点(半|\d{1,2}分?)?)?/,
      );
      if (!match) return token;
      let hour = Number(match[2]);
      const minute = match[3]
        ? Number(match[3])
        : match[4] === "半"
          ? 30
          : Number((match[4] || "0").replace("分", ""));
      if (["下午", "晚上"].includes(match[1]) && hour < 12) hour += 12;
      if (match[1] === "中午" && hour < 11) hour += 12;
      if (hour > 23 || minute > 59) return token;
      result.time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      result.dueDate ||= today;
      return "";
    },
  );
  result.title = title.replace(/\s+/g, " ").trim() || text.trim();
  return result;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    afterQuote = false;
  const content = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += char;
    } else if (char === '"' && !field && !afterQuote) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      afterQuote = false;
      if (char !== ",") {
        if (char === "\r" && content[i + 1] === "\n") i++;
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
      }
    } else if (afterQuote && char.trim())
      throw new Error("CSV 引号结束后出现无效字符");
    else if (!afterQuote) field += char;
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号");
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function stableId(text: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `import-${hash.toString(16)}`;
}

function importCsv(text: string): { data: AppData; warnings: string[] } {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((row) =>
    row.some((value) =>
      /^(Title|Task Name|任务名称|任务标题|标题)$/i.test(value.trim()),
    ),
  );
  if (headerIndex < 0)
    throw new Error("CSV 中没有找到任务标题列，请使用滴答清单导出的备份 CSV");
  const headers = rows[headerIndex].map((value) => value.trim().toLowerCase());
  const data = createEmptyData();
  const warnings: string[] = [];
  const get = (row: string[], ...names: string[]) => {
    const index = headers.findIndex((value) => names.includes(value));
    return index < 0 ? "" : (row[index] || "").trim();
  };
  const convertDate = (
    value: string,
    rowIndex: number,
  ): { date: string | null; time: string | null } => {
    if (!value) return { date: null, time: null };
    if (isDate(value)) return { date: value, time: null };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      warnings.push(`第 ${rowIndex + 1} 行日期无效，已保留任务但省略该日期`);
      return { date: null, time: null };
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      warnings.push(
        `第 ${rowIndex + 1} 行日期无法识别，已保留任务但省略该日期`,
      );
      return { date: null, time: null };
    }
    return {
      date: localDate(parsed),
      time: `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`,
    };
  };
  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    const title = get(
      row,
      "title",
      "task name",
      "任务名称",
      "任务标题",
      "标题",
    );
    if (!title) continue;
    const listName =
      get(row, "list name", "list", "清单名称", "清单") || "收集箱";
    let list = data.lists.find((item) => item.name === listName);
    if (!list) {
      list = {
        id: stableId(`list:${listName}`),
        name: listName,
        color: "#4772FA",
        folderId: null,
        archived: false,
        sortOrder: data.lists.length,
      };
      data.lists.push(list);
    }
    const due = convertDate(
      get(row, "due date", "due", "截止日期", "日期"),
      index,
    );
    const start = convertDate(get(row, "start date", "开始日期"), index);
    const completion = get(row, "completed time", "completed date", "完成时间");
    const created = get(row, "created time", "created date", "创建时间");
    const status = get(row, "status", "状态");
    const repeat = get(row, "repeat", "repeat rule", "重复");
    const rawPriority = get(row, "priority", "优先级");
    const priority =
      rawPriority === "5" || /high|高/i.test(rawPriority)
        ? 1
        : rawPriority === "3" || /medium|中/i.test(rawPriority)
          ? 2
          : rawPriority === "1" || /low|低/i.test(rawPriority)
            ? 3
            : 0;
    let rule: RepeatRule = /FREQ=DAILY|每天/i.test(repeat)
      ? "daily"
      : /FREQ=WEEKLY|每周/i.test(repeat)
        ? "weekly"
        : /FREQ=MONTHLY|每月/i.test(repeat)
          ? "monthly"
          : /FREQ=YEARLY|每年/i.test(repeat)
            ? "yearly"
            : "none";
    const complexRule =
      !!repeat &&
      (rule === "none" ||
        /(?:INTERVAL=(?!1(?:;|$))\d+|BYDAY=|BYMONTHDAY=|BYMONTH=|UNTIL=|COUNT=|DFROM=|ERULE:)/i.test(
          repeat,
        ));
    if (complexRule) {
      rule = "none";
      warnings.push(
        `第 ${index + 1} 行的复杂重复规则未转换，原规则已保留在任务描述中，请在导入后检查`,
      );
    }
    const content = get(row, "content", "description", "内容", "描述");
    const stamp = new Date().toISOString();
    data.tasks.push(
      createTask({
        id: stableId(JSON.stringify({ row, index })),
        title,
        listId: list.id,
        content: complexRule
          ? `${content}${content ? "\n\n" : ""}原重复规则：${repeat}`
          : content,
        dueDate: due.date || start.date,
        startDate:
          start.date && due.date && start.date <= due.date ? start.date : null,
        time: /^(true|1)$/i.test(get(row, "is all day", "全天"))
          ? null
          : due.time || start.time,
        priority,
        repeat: rule,
        tags: get(row, "tags", "标签")
          .split(/[,;，]/)
          .map((value) => value.replace(/^#/, "").trim())
          .filter(Boolean),
        completedAt:
          completion && Number.isFinite(Date.parse(completion))
            ? new Date(completion).toISOString()
            : /^(2|completed|已完成)$/i.test(status)
              ? stamp
              : null,
        createdAt:
          created && Number.isFinite(Date.parse(created))
            ? new Date(created).toISOString()
            : stamp,
      }),
    );
  }
  return { data: validateData(data), warnings };
}

export function importBackupText(
  text: string,
  current: AppData,
): { data: AppData; count: number; warnings: string[] } {
  if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024)
    throw new Error("备份文件超过 32 MB，请拆分后再导入");
  const stripped = text.replace(/^\uFEFF/, "").trim();
  let incoming: AppData,
    warnings: string[] = [];
  if (stripped.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      throw new Error("备份 JSON 无法解析，现有数据未改动");
    }
    if (parsed && typeof parsed === "object" && "data" in parsed)
      parsed = (parsed as { data: unknown }).data;
    incoming = validateData(parsed);
  } else ({ data: incoming, warnings } = importCsv(stripped));
  const validCurrent = validateData(current);
  const merge = <T extends { id: string }>(
    existing: T[],
    additions: T[],
  ): T[] => {
    const ids = new Set(existing.map((item) => item.id));
    return [...existing, ...additions.filter((item) => !ids.has(item.id))];
  };
  const count = incoming.tasks.filter(
    (task) => !validCurrent.tasks.some((existing) => existing.id === task.id),
  ).length;
  const duplicates = incoming.tasks.length - count;
  if (duplicates)
    warnings.push(`${duplicates} 个已存在的任务保留本机版本，未重复导入`);
  const data = validateData({
    ...validCurrent,
    tasks: merge(validCurrent.tasks, incoming.tasks),
    lists: merge(validCurrent.lists, incoming.lists),
    folders: merge(validCurrent.folders, incoming.folders),
    habits: merge(validCurrent.habits, incoming.habits),
    filters: merge(validCurrent.filters, incoming.filters),
    focusSessions: merge(validCurrent.focusSessions, incoming.focusSessions),
  });
  return { data, count, warnings };
}
