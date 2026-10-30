import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import {mkdir} from "node:fs/promises";
import {chromium, type Browser, type Page} from "playwright";
import {createServer, type ViteDevServer} from "vite";
import {addDays, createEmptyData, createTask, localDate} from "../src/core/domain.ts";
import type {CoreSnapshot} from "../src/generated/contracts.ts";

// These tests exercise the shipped React entries. Only the Tauri IPC boundary is a fixture;
// Rust semantics and native window behavior need their own integration acceptance.
let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createServer({server: {host: "127.0.0.1", port: 0, strictPort: false, watch: {ignored: ["**/target/**", "**/.local/**", "**/tests/web-evidence/**"]}}});
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({headless: true, executablePath: process.env.DITALIST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"});
  await mkdir("tests/web-evidence", {recursive: true});
});
after(async () => { await browser?.close(); await server?.close(); });

function fixture(): CoreSnapshot {
  const data = createEmptyData();
  data.settings.defaultView = "all";
  data.settings.customTags = [];
  data.tasks = [
    createTask({id: "existing", title: "准备周报", dueDate: localDate(), content: "已有的描述"}),
    createTask({id: "pending", title: "Agent 建议整理会议", createdBy: "agent", agentStatus: "pending"}),
  ];
  return {
    data: data as CoreSnapshot["data"], revision: 1, entityVersions: {existing: 1, pending: 1},
    approvals: [{id: "proposal", taskId: "existing", patch: {title: "整理项目周报", priority: 1}, baseVersion: 1, status: "pending", createdAt: new Date().toISOString()}],
    reminders: [], focus: {mode: "focus", running: true, taskId: "existing", title: "准备周报", startedAt: new Date(Date.now() - 266_000).toISOString(), deadline: new Date(Date.now() + 1_234_000).toISOString(), remainingSeconds: 1234, elapsedSeconds: 266, targetSeconds: 1500},
    preferences: {floatingVisible: true, mcpEnabled: false, quiet: false, confirmPurge: true}, todayCount: 1, pendingCount: 2, reminderCount: 0,
  };
}

async function open(entry = "", state = fixture(), clockAt?: number): Promise<Page> {
  const page = await browser.newPage({viewport: {width: 1180, height: 820}});
  if (clockAt !== undefined) await page.clock.install({time: clockAt - 3_600_000});
  await page.addInitScript((initial) => {
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    const f = (window as any).__fixture = {
      snapshot: initial, commands: [] as any[], actions: [] as any[], draft: {text: "", requestId: null as string | null},
      failures: {} as Record<string, number>, receipts: {} as Record<string, any>,
      draftFailures: 0, waitCommand: false, releaseCommand: null as (() => void) | null,
      mcp: {state: "closed", command: "D:\\DitaList Preview\\ditalist-mcp.exe", args: ["--data-dir", "D:\\isolated"], contactPath: "D:\\isolated\\contact.json", address: null},
      emit(event: string, payload: any) { for (const id of listeners.get(event) || []) callbacks.get(id)?.({event, id, payload}); },
    };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: Function) { const id = next++; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: any) {
        if (command === "plugin:event|listen") { listeners.set(args.event, [...(listeners.get(args.event) || []), args.handler]); return args.handler; }
        if (command === "plugin:event|unlisten") { listeners.set(args.event, (listeners.get(args.event) || []).filter((id) => id !== args.eventId)); return; }
        if (command === "core_snapshot") return structuredClone(f.snapshot);
        if (command === "core_get_request") return f.receipts[args.requestId] || null;
        if (command === "core_execute") {
          const c = structuredClone(args.command); f.commands.push(c);
          if (f.waitCommand) await new Promise<void>((resolve) => { f.releaseCommand = resolve; });
          if (f.failures[c.operation.type] > 0) { f.failures[c.operation.type]--; throw {code: "storage", message: "模拟保存失败，内容已保留"}; }
          if (f.receipts[c.requestId]) return f.receipts[c.requestId];
          const receipt = {requestId: c.requestId, status: "applied", revision: ++f.snapshot.revision, createdAt: new Date().toISOString(), result: {id: "created"}};
          f.receipts[c.requestId] = receipt;
          if (c.operation.type === "taskUpdate") Object.assign(f.snapshot.data.tasks.find((task: any) => task.id === c.operation.id), c.operation.patch);
          if (c.operation.type === "settingsUpdate") Object.assign(f.snapshot.data.settings, c.operation.patch);
          if (c.operation.type === "navigationUpdate") f.snapshot.data.settings.navigation = structuredClone(c.operation.preferences);
          f.emit("core://changed", structuredClone(f.snapshot));
          return receipt;
        }
        if (command === "desktop_status") return {floatingVisible: true, shortcutExists: false, dataPath: "D:\\isolated\\data.json", backupPath: "D:\\isolated\\backups"};
        if (command === "desktop_action") { f.actions.push(args); return; }
        if (command === "draft_get") return structuredClone(f.draft);
        if (command === "draft_set") { if (f.draftFailures > 0) { f.draftFailures--; throw new Error("草稿交接失败"); } f.draft = structuredClone(args.draft); return; }
        if (command === "mcp_info") return structuredClone(f.mcp);
        throw new Error(`Unexpected IPC: ${command}`);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener(_event: string, id: number) {callbacks.delete(id);}};
  }, state);
  await page.goto(`${url}${entry}`);
  await page.waitForFunction(() => (window as any).__fixture.actions.some((action: any) => action.action === "ready"));
  if (clockAt !== undefined) await page.clock.pauseAt(clockAt);
  return page;
}

test("pending Agent changes remain quiet until opened; approval uses the proposal id", async () => {
  const page = await open();
  try {
    assert.equal(await page.getByRole("heading", {name: "所有任务", exact: true}).count(), 1);
    assert.equal(await page.getByRole("region", {name: "Agent 待确认"}).count(), 0);
    assert.equal(await page.locator('.task-row[data-task-id="pending"]').count(), 0);
    await page.getByRole("button", {name: /Agent 待确认/}).click();
    await page.getByRole("region", {name: "Agent 待确认"}).waitFor();
    assert.equal(await page.getByRole("dialog", {name: "Agent 待确认"}).count(), 0);
    assert.equal(await page.getByRole("heading", {name: "所有任务", exact: true}).count(), 0);
    assert.equal(await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).count(), 0);
    assert.equal(await page.getByRole("textbox").count(), 0);
    assert.equal(await page.locator(".approval-diff del").first().textContent(), "准备周报");
    assert.equal(await page.locator(".approval-diff ins").first().textContent(), "整理项目周报");
    await page.screenshot({path: "tests/web-evidence/agent-review-light.png"});
    await page.locator(".agent-review-item").filter({hasText: "修改任务"}).getByRole("button", {name: "批准", exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.some((item: any) => item.operation.type === "agentApprove"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands[0].operation), {type: "agentApprove", id: "proposal"});
  } finally { await page.close(); }
});

test("task pages have no inline input and Plus opens the shared task form with clear date defaults", async () => {
  const page = await open();
  try {
    for (const view of ["all", "inbox", "today", "next7"]) {
      await page.locator(`[data-nav-id="${view}"]`).click();
      assert.equal(await page.locator(".quick-add").count(), 0);
      assert.equal(await page.getByRole("textbox").count(), 0);
      await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click();
      await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill(`统一入口 ${view}`);
      const expected = view === "today" || view === "next7" ? localDate() : "";
      assert.equal(await page.getByRole("textbox", {name: "新任务日期", exact: true}).inputValue(), expected);
      await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
      await page.locator(".new-task-dialog").waitFor({state: "detached"});
      const operation = await page.evaluate(() => (window as any).__fixture.commands.at(-1).operation);
      assert.equal(operation.type, "quickAdd");
      assert.equal(operation.date, expected || "none");
      assert.equal(operation.listId, "inbox");
      assert.equal(operation.overrides.dueDate, undefined);
    }
  } finally { await page.close(); }
});

test("Ctrl+N follows the same view context; clearing Today date stays undated", async () => {
  const page = await open();
  try {
    await page.locator('[data-nav-id="today"]').click();
    await page.keyboard.press("Control+n");
    await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill("取消默认日期");
    await page.getByRole("textbox", {name: "新任务日期", exact: true}).fill("");
    await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.length === 1);
    const operation = await page.evaluate(() => (window as any).__fixture.commands[0].operation);
    assert.equal(operation.date, localDate());
    assert.equal(operation.overrides.dueDate, null);
    await page.locator('[data-nav-id="all"]').click();
    await page.keyboard.press("Control+n");
    assert.equal(await page.getByRole("textbox", {name: "新任务日期", exact: true}).inputValue(), "");
  } finally { await page.close(); }
});

test("Chinese task dates override page defaults while an explicit date selection wins", async () => {
  const state = fixture(); state.data.settings.defaultView = "today";
  const page = await open("", state);
  try {
    await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click();
    await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill("明天开会");
    assert.equal(await page.getByRole("textbox", {name: "新任务日期", exact: true}).inputValue(), addDays(localDate(), 1));
    await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
    await page.locator(".new-task-dialog").waitFor({state: "detached"});
    const parsed = await page.evaluate(() => (window as any).__fixture.commands[0].operation);
    assert.equal(parsed.date, localDate());
    assert.equal(parsed.overrides.dueDate, undefined);
    await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click();
    await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill("明天开会");
    await page.getByRole("textbox", {name: "新任务日期", exact: true}).fill(addDays(localDate(), 3));
    await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
    await page.locator(".new-task-dialog").waitFor({state: "detached"});
    assert.equal(await page.evaluate(() => (window as any).__fixture.commands[1].operation.overrides.dueDate), addDays(localDate(), 3));
  } finally { await page.close(); }
});

test("overdue group Plus creates for today instead of inheriting an arbitrary past date", async () => {
  const state = fixture(); state.data.tasks[0].dueDate = addDays(localDate(), -4);
  const page = await open("", state);
  try {
    await page.locator(".group-heading.overdue button").click();
    assert.equal(await page.getByRole("textbox", {name: "新任务日期", exact: true}).inputValue(), localDate());
  } finally { await page.close(); }
});

test("date group Plus uses that group date and failed save retains the task form", async () => {
  const state = fixture(); const tomorrow = addDays(localDate(), 1);
  state.data.tasks[0].dueDate = tomorrow;
  const page = await open("", state);
  try {
    await page.locator(".group-heading button").first().click();
    assert.equal(await page.getByRole("textbox", {name: "新任务日期", exact: true}).inputValue(), tomorrow);
    await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill("失败后保留的新任务");
    await page.evaluate(() => { (window as any).__fixture.failures.quickAdd = 1; });
    await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
    await page.locator(".new-task-dialog").getByRole("alert").waitFor();
    assert.equal(await page.getByRole("textbox", {name: "新任务标题", exact: true}).inputValue(), "失败后保留的新任务");
    await page.locator(".new-task-dialog").getByRole("button", {name: "添加", exact: true}).click();
    await page.locator(".new-task-dialog").waitFor({state: "detached"});
    const commands = await page.evaluate(() => (window as any).__fixture.commands);
    assert.equal(commands[0].requestId, commands[1].requestId);
  } finally { await page.close(); }
});

test("paused focus keeps the original target and title until reset", async () => {
  const state = fixture();
  state.focus.running = false;
  state.focus.deadline = null;
  state.data.tasks[0].completedAt = new Date().toISOString();
  state.data.tasks[0].title = "后来修改的标题";
  state.data.tasks.push(createTask({id: "another", title: "另一个任务"}));
  const page = await open("", state);
  try {
    await page.getByRole("button", {name: "专注", exact: true}).click();
    const selector = page.locator(".focus-task-select .custom-select-trigger");
    assert.equal(await selector.isDisabled(), true);
    assert.match(await selector.textContent() || "", /准备周报/);
    await page.getByRole("button", {name: "重置计时", exact: true}).click();
    await page.evaluate(() => {
      const f = (window as any).__fixture; f.snapshot.focus.startedAt = null;
      f.snapshot.revision++; f.emit("core://changed", structuredClone(f.snapshot));
    });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.focus-task-select .custom-select-trigger')?.disabled);
    await selector.click();
    await page.getByRole("listbox", {name: "选择专注任务", exact: true}).getByRole("option", {name: "另一个任务", exact: true}).waitFor();
  } finally { await page.close(); }
});

test("main exit refuses unsubmitted input, flushes detail edits and unlocks on cancellation", async () => {
  const page = await open();
  try {
    await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click();
    const quick = page.getByRole("textbox", {name: "新任务标题", exact: true});
    await quick.fill("尚未提交");
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "main"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.actions.find((item: any) => item.action === "exitReady").payload), {window: "main", ready: false});
    await page.evaluate(() => { const f = (window as any).__fixture; f.emit("desktop://exit-cancelled", {}); f.actions = []; });
    await page.locator(".new-task-dialog").getByRole("button", {name: "取消", exact: true}).click();
    await page.locator('.task-row[data-task-id="existing"]').click();
    await page.getByRole("textbox", {name: "任务标题", exact: true}).fill("退出前必须保存的标题");
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "main"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady" && item.payload.ready));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands[0].operation.patch), {title: "退出前必须保存的标题"});
    assert.equal(await page.evaluate(() => document.body.inert), true);
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeMain")), false);
    await page.evaluate(() => (window as any).__fixture.emit("desktop://exit-cancelled", {}));
    await page.waitForFunction(() => !document.body.inert);
  } finally { await page.close(); }
});

test("quick exit waits for composition and submission; draft failure refuses exit", async () => {
  const page = await open("floating.html");
  try {
    const input = page.getByRole("textbox", {name: "快速添加任务"});
    await input.fill("输入法完成后的草稿");
    await input.dispatchEvent("compositionstart", {data: "草稿"});
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "quick"}));
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady")), false);
    await input.dispatchEvent("compositionend", {data: "草稿"});
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady" && item.payload.ready));
    assert.equal(await page.evaluate(() => (window as any).__fixture.draft.text), "输入法完成后的草稿");
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeQuick")), false);
    await page.evaluate(() => { const f = (window as any).__fixture; f.emit("desktop://exit-cancelled", {}); f.actions = []; f.draftFailures = 1; });
    await page.waitForFunction(() => !document.body.inert);
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "quick"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.actions.find((item: any) => item.action === "exitReady").payload), {window: "quick", ready: false});
  } finally { await page.close(); }
  const sendingPage = await open("floating.html");
  try {
    await sendingPage.getByRole("textbox", {name: "快速添加任务"}).fill("已经开始提交的任务");
    await sendingPage.evaluate(() => { (window as any).__fixture.waitCommand = true; });
    await sendingPage.getByRole("button", {name: "添加任务", exact: true}).click();
    await sendingPage.waitForFunction(() => (window as any).__fixture.releaseCommand !== null);
    await sendingPage.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "quick"}));
    assert.equal(await sendingPage.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady")), false);
    await sendingPage.evaluate(() => (window as any).__fixture.releaseCommand());
    await sendingPage.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady" && item.payload.ready));
    assert.deepEqual(await sendingPage.evaluate(() => (window as any).__fixture.draft), {text: "", requestId: null});
    assert.equal(await sendingPage.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeQuick")), false);
  } finally { await sendingPage.close(); }
});

test("calendar retains four views and completion; habits record through concrete core operations", async () => {
  const state = fixture(); const today = localDate();
  state.data.habits = [{id: "reading", name: "读书", icon: "📖", color: "#4772fa", goal: 1, days: [0, 1, 2, 3, 4, 5, 6], records: {}, createdAt: new Date().toISOString()}];
  const page = await open("", state);
  try {
    await page.getByRole("button", {name: "日历", exact: true}).click();
    const modes = page.getByRole("group", {name: "日历视图"});
    for (const [label, value] of [["日", "day"], ["周", "week"], ["月", "month"], ["议程", "agenda"]]) {
      await modes.getByRole("button", {name: label, exact: true}).click();
      await page.waitForFunction((mode) => (window as any).__fixture.snapshot.data.settings.calendarMode === mode, value);
      await page.locator(`.cal-mode-switch button[aria-pressed="true"]`).filter({hasText: label}).waitFor();
    }
    assert.equal(await page.getByText("Agent 建议整理会议", {exact: true}).count(), 0);
    await page.getByRole("button", {name: "完成：准备周报", exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.some((item: any) => item.operation.type === "taskComplete"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands.find((item: any) => item.operation.type === "taskComplete").operation), {type: "taskComplete", id: "existing", completed: true});
    await page.getByRole("button", {name: "习惯", exact: true}).click();
    await page.getByRole("button", {name: `读书 ${today} 打卡`, exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.some((item: any) => item.operation.type === "habitRecord"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands.find((item: any) => item.operation.type === "habitRecord").operation), {type: "habitRecord", id: "reading", date: today, value: 1});
  } finally { await page.close(); }
});

test("focus displays authoritative time and MCP closing keeps its toggle disabled", async () => {
  const state = fixture(); state.data.settings.theme = "dark";
  const clockAt = Date.now(); state.focus.deadline = new Date(clockAt + 1_234_000).toISOString();
  const page = await open("", state, clockAt);
  try {
    await page.getByRole("button", {name: "专注", exact: true}).click();
    assert.equal(await page.locator(".timer-dial strong").textContent(), "20:34");
    await page.getByRole("button", {name: "暂停", exact: true}).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands[0].operation), {type: "focus", action: "pause", taskId: "existing"});
    await page.screenshot({path: "tests/web-evidence/focus-dark.png"});
    await page.locator(".navigation-settings").click();
    await page.getByRole("button", {name: "Agent / MCP", exact: true}).click();
    await page.locator(".mcp-config").waitFor();
    assert.match(await page.locator(".mcp-config").textContent() || "", /ditalist-mcp\.exe/);
    await page.evaluate(() => { const f = (window as any).__fixture; f.mcp.state = "closing"; f.emit("mcp://state", structuredClone(f.mcp)); });
    assert.equal(await page.getByRole("checkbox", {name: /MCP 通道/}).isDisabled(), true);
    assert.equal(await page.getByText("正在保存已受理的请求和回执，完成后关闭连接。").isVisible(), true);
    await page.evaluate(() => { const f = (window as any).__fixture; f.mcp.state = "closing_failed"; f.emit("mcp://state", structuredClone(f.mcp)); });
    await page.getByRole("button", {name: "重试关闭", exact: true}).click();
    const retried = await page.evaluate(() => (window as any).__fixture.commands.at(-1).operation);
    assert.deepEqual(retried, {type: "preferencesUpdate", patch: {mcpEnabled: false}});
  } finally { await page.close(); }
});

test("focus paints the core deadline, stops while hidden and catches up without completing business state", async () => {
  const state = fixture(); const clockAt = Date.now();
  state.focus.deadline = new Date(clockAt + 10_000).toISOString();
  // A stale snapshot count must not become a new local session when the page opens.
  state.focus.remainingSeconds = 1234;
  const page = await open("", state, clockAt);
  try {
    await page.getByRole("button", {name: "专注", exact: true}).click();
    const dial = page.locator(".timer-dial strong");
    await page.waitForFunction(() => document.querySelector(".timer-dial strong")?.textContent === "00:10");
    await page.clock.runFor(2000);
    assert.equal(await dial.textContent(), "00:08");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", {configurable: true, value: true}); document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.runFor(5000);
    assert.equal(await dial.textContent(), "00:08");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", {configurable: true, value: false}); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForFunction(() => document.querySelector(".timer-dial strong")?.textContent === "00:03");
    await page.clock.runFor(1000);
    assert.equal(await dial.textContent(), "00:02");
    await page.getByRole("button", {name: "任务", exact: true}).click();
    await page.clock.runFor(3000);
    assert.equal(await dial.textContent(), "00:02");
    await page.getByRole("button", {name: "专注", exact: true}).click();
    await page.waitForFunction(() => document.querySelector(".timer-dial strong")?.textContent === "00:00");
    assert.equal(await page.evaluate(() => (window as any).__fixture.snapshot.focus.running), true);
    assert.equal(await page.evaluate(() => (window as any).__fixture.snapshot.data.focusSessions.length), 0);
    assert.equal(await page.evaluate(() => (window as any).__fixture.commands.length), 0);
    await page.evaluate(() => {
      const f = (window as any).__fixture; Object.assign(f.snapshot.focus, {running: false, deadline: null, remainingSeconds: 7});
      f.snapshot.revision++; f.emit("core://changed", structuredClone(f.snapshot));
    });
    await page.clock.runFor(3000);
    assert.equal(await dial.textContent(), "00:07");
    await page.evaluate(() => {
      const f = (window as any).__fixture; Object.assign(f.snapshot.focus, {running: true, deadline: new Date(Date.now() + 5000).toISOString()});
      f.snapshot.revision++; f.emit("core://changed", structuredClone(f.snapshot));
    });
    await page.waitForFunction(() => document.querySelector(".timer-dial strong")?.textContent === "00:05");
    await page.clock.runFor(1000);
    assert.equal(await dial.textContent(), "00:04");
  } finally { await page.close(); }
});

test("subtask blur and immediate completion preserve both edits in queued core operations", async () => {
  const state = fixture(); state.data.tasks[0].subtasks = [{id: "step", title: "原子任务", completed: false}];
  const page = await open("", state);
  try {
    await page.locator('.task-row[data-task-id="existing"]').click();
    await page.getByRole("textbox", {name: "子任务标题", exact: true}).fill("修改后子任务");
    await page.getByRole("button", {name: "完成子任务 修改后子任务", exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.filter((item: any) => item.operation.type === "taskUpdate").length === 2);
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.commands.at(-1).operation.patch.subtasks), [{id: "step", title: "修改后子任务", completed: true}]);
    await page.getByRole("textbox", {name: "添加子任务", exact: true}).fill("还没有提交");
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-close", {window: "main"}));
    await page.getByText("有尚未提交的输入或表单，请先保存或取消，再关闭主界面。").waitFor();
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeMain")), false);
  } finally { await page.close(); }
});

test("navigation restores existing ordering and hidden items", async () => {
  const state = fixture();
  state.data.lists.push({id: "work", name: "工作清单", color: "#4772fa", folderId: null, archived: false, sortOrder: 0});
  state.data.settings.navigation = {orders: {sidebar: ["all", "today", "inbox"]}, hidden: ["inbox"]};
  const page = await open("", state);
  try {
    const navIds = await page.locator(".navigation-system-entry [data-nav-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-nav-id")));
    assert.deepEqual(navIds.slice(0, 2), ["all", "today"]); assert.equal(navIds.includes("inbox"), false);
    assert.equal(await page.getByRole("button", {name: "编辑导航", exact: true}).count(), 0);
    assert.equal(await page.getByRole("dialog", {name: "编辑导航", exact: true}).count(), 0);
  } finally { await page.close(); }
});

test("a newer successful navigation layout supersedes the failed save and unlocks exit", async () => {
  const page = await open();
  try {
    await page.locator('[data-nav-id="today"]').click({button: "right"});
    await page.getByRole("button", {name: "隐藏今天", exact: true}).click();
    await page.evaluate(() => { (window as any).__fixture.failures.navigationUpdate = 1; });
    await page.getByRole("region", {name: "整理导航"}).getByRole("button", {name: "完成", exact: true}).click();
    await page.getByRole("region", {name: "整理导航"}).getByRole("alert").waitFor();
    await page.getByRole("button", {name: "显示今天", exact: true}).click();
    await page.getByRole("button", {name: "隐藏最近7天", exact: true}).click();
    await page.getByRole("region", {name: "整理导航"}).getByRole("button", {name: "完成", exact: true}).click();
    await page.getByRole("region", {name: "整理导航"}).waitFor({state: "detached"});
    assert.equal(await page.locator(".save-recovery").count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.snapshot.data.settings.navigation.hidden), ["next7"]);
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "main"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady" && item.payload.ready));
  } finally { await page.close(); }
});

test("date filters include spanning tasks, optional undated tasks, completion dates and per-view sessions", async () => {
  const state = fixture(); const today = localDate();
  state.data.tasks.push(
    createTask({id: "span", title: "跨日项目", startDate: addDays(today, -1), dueDate: addDays(today, 1)}),
    createTask({id: "undated", title: "无日期待办"}),
    createTask({id: "done", title: "今天完成的记录", completedAt: new Date().toISOString(), dueDate: addDays(today, -10)}),
  );
  const page = await open("", state);
  try {
    await page.setViewportSize({width: 920, height: 680});
    await page.getByRole("button", {name: "任务筛选", exact: true}).click();
    let panel = page.getByRole("dialog", {name: "任务筛选", exact: true});
    await panel.getByRole("button", {name: "今天", exact: true}).click();
    await panel.getByRole("button", {name: "未完成", exact: true}).click();
    await panel.getByRole("button", {name: "应用", exact: true}).click();
    assert.equal(await page.locator('.task-row[data-task-id="span"]').count(), 1);
    assert.equal(await page.locator('.task-row[data-task-id="undated"]').count(), 0);
    await page.getByRole("button", {name: /^任务筛选，/}).click();
    panel = page.getByRole("dialog", {name: "任务筛选", exact: true});
    await panel.getByRole("checkbox", {name: "同时包含无日期任务"}).check();
    await panel.getByRole("button", {name: "应用", exact: true}).click();
    assert.equal(await page.locator('.task-row[data-task-id="undated"]').count(), 1);
    await page.locator('[data-nav-id="inbox"]').click();
    assert.equal(await page.locator(".task-filter-summary").count(), 0);
    await page.locator('[data-nav-id="all"]').click();
    assert.equal(await page.locator(".task-filter-summary").count(), 1);
    await page.getByRole("button", {name: /^任务筛选，/}).click();
    panel = page.getByRole("dialog", {name: "任务筛选", exact: true});
    await panel.getByRole("button", {name: "完成日期", exact: true}).click();
    await page.screenshot({path: "tests/web-evidence/task-filter-compact.png"});
    await panel.getByRole("button", {name: "应用", exact: true}).click();
    assert.equal(await page.locator(".task-row").count(), 1);
    assert.equal(await page.locator('.task-row[data-task-id="done"]').count(), 1);
    assert.equal(await page.evaluate(() => (window as any).__fixture.commands.length), 0);
    // Search restores the destination view by clearing that view's transient filter.
    await page.locator('[data-nav-id="inbox"]').click();
    await page.getByRole("button", {name: "任务筛选", exact: true}).click();
    panel = page.getByRole("dialog", {name: "任务筛选", exact: true});
    await panel.getByRole("button", {name: "今天", exact: true}).click();
    await panel.getByRole("button", {name: "应用", exact: true}).click();
    await page.getByRole("button", {name: "搜索 Ctrl+K", exact: true}).click();
    await page.getByRole("textbox", {name: "搜索全部任务"}).fill("无日期待办");
    await page.locator(".search-results button").click();
    assert.equal(await page.locator(".task-filter-summary").count(), 0);
    assert.equal(await page.locator('.task-row[data-task-id="undated"]').count(), 1);
  } finally { await page.close(); }
});

test("a failed detail write survives unrelated success and blocks window release until retry", async () => {
  const page = await open();
  try {
    await page.locator('.task-row[data-task-id="existing"]').click();
    await page.evaluate(() => { (window as any).__fixture.failures.taskUpdate = 1; });
    await page.getByRole("textbox", {name: "任务标题", exact: true}).fill("需要重试的周报标题");
    await page.getByRole("textbox", {name: "任务描述", exact: true}).click();
    await page.getByText("1 项操作尚未确认保存").waitFor();
    await page.getByRole("button", {name: "完成任务", exact: true}).click();
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-close", {window: "main"}));
    await page.getByText("还有未确认保存的操作，请先重试或放弃这些操作，再关闭。").waitFor();
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeMain")), false);
    await page.getByRole("button", {name: "重试保存", exact: true}).click();
    await page.getByText("1 项操作尚未确认保存").waitFor({state: "detached"});
    const updates = await page.evaluate(() => (window as any).__fixture.commands.filter((item: any) => item.operation.type === "taskUpdate"));
    assert.equal(updates[0].requestId, updates[1].requestId);
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-close", {window: "main"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeMain"));
  } finally { await page.close(); }
});

test("quick input keeps failed text and retries the same id; collapse first hands off drafts", async () => {
  const page = await open("floating.html");
  try {
    const input = page.getByRole("textbox", {name: "快速添加任务"});
    await input.fill("明天下午三点讨论计划 #工作");
    await page.evaluate(() => { (window as any).__fixture.failures.quickAdd = 1; });
    await page.getByRole("button", {name: "添加任务", exact: true}).click();
    await page.getByRole("button", {name: "重试上次提交"}).waitFor();
    assert.equal(await input.inputValue(), "明天下午三点讨论计划 #工作");
    assert.equal(await input.getAttribute("readonly"), "");
    await page.screenshot({path: "tests/web-evidence/quick-save-error.png"});
    await page.evaluate(() => (window as any).__fixture.emit("desktop://prepare-exit", {window: "quick"}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "exitReady"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.actions.find((item: any) => item.action === "exitReady").payload), {window: "quick", ready: false});
    await page.evaluate(() => (window as any).__fixture.emit("desktop://exit-cancelled", {}));
    await page.waitForFunction(() => !document.body.inert);
    await page.getByRole("button", {name: "重试上次提交"}).click();
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeQuick"));
    const commands = await page.evaluate(() => (window as any).__fixture.commands);
    assert.equal(commands.length, 2); assert.equal(commands[0].requestId, commands[1].requestId);
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.draft), {text: "", requestId: null});
  } finally { await page.close(); }
  const draftPage = await open("floating.html");
  try {
    await draftPage.getByRole("textbox", {name: "快速添加任务"}).fill("尚未提交的草稿");
    await draftPage.evaluate(() => (window as any).__fixture.emit("desktop://prepare-close", {window: "quick"}));
    await draftPage.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "closeQuick"));
    assert.deepEqual(await draftPage.evaluate(() => (window as any).__fixture.draft), {text: "尚未提交的草稿", requestId: null});
    assert.equal(await draftPage.evaluate(() => (window as any).__fixture.commands.length), 0);
  } finally { await draftPage.close(); }
});
