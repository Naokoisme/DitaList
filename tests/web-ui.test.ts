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
  await mkdir("reports", {recursive: true});
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
    preferences: {floatingVisible: true, mcpEnabled: false, quiet: false, confirmPurge: true}, todayCount: 1, pendingCount: 2, reminderCount: 0, tagIndex: [], listIndex: [],
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
      failures: {} as Record<string, number>, failureCodes: {} as Record<string, string>, receipts: {} as Record<string, any>,
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
          if (f.failures[c.operation.type] > 0) { f.failures[c.operation.type]--; throw {code: f.failureCodes[c.operation.type] || "storage", message: "模拟保存失败，内容已保留"}; }
          if (f.receipts[c.requestId]) return f.receipts[c.requestId];
          const receipt = {requestId: c.requestId, status: "applied", revision: ++f.snapshot.revision, createdAt: new Date().toISOString(), result: {id: "created"}};
          f.receipts[c.requestId] = receipt;
          if (c.operation.type === "taskUpdate") Object.assign(f.snapshot.data.tasks.find((task: any) => task.id === c.operation.id), c.operation.patch);
          if (c.operation.type === "taskComplete") Object.assign(f.snapshot.data.tasks.find((task: any) => task.id === c.operation.id), {completedAt: c.operation.completed ? new Date().toISOString() : null});
          if (c.operation.type === "taskTrash") Object.assign(f.snapshot.data.tasks.find((task: any) => task.id === c.operation.id), {deletedAt: new Date().toISOString()});
          if (c.operation.type === "taskRestore") Object.assign(f.snapshot.data.tasks.find((task: any) => task.id === c.operation.id), {deletedAt: null});
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

for (const theme of ["light", "dark"] as const) {
  test(`window controls clear stale hover after hiding and reopen (${theme})`, async () => {
    const state = fixture(); state.data.settings.theme = theme;
    const page = await open("", state);
    try {
      if (theme === "dark") await page.setViewportSize({width: 800, height: 720});
      const close = page.getByRole("button", {name: "关闭窗口", exact: true});
      const background = () => close.evaluate((button) => getComputedStyle(button).backgroundColor);
      await close.hover();
      assert.equal(await background(), "rgb(227, 76, 76)");
      await close.click();
      await page.waitForFunction(() => (window as any).__fixture.actions.some((action: any) => action.action === "closeMain"));
      // The fixture leaves the DOM at its old pointer coordinates, reproducing
      // retained :hover independently of the explicit interaction state.
      assert.equal(await close.evaluate((button) => button.matches(":hover")), true);
      assert.equal(await background(), "rgba(0, 0, 0, 0)");
      assert.equal(await close.evaluate((button) => document.activeElement === button), false);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        (window as any).__fixture.emit("desktop://navigate", {view: "today"});
      });
      assert.equal(await background(), "rgba(0, 0, 0, 0)");
      assert.equal(await page.evaluate(() => (window as any).__fixture.actions.filter((action: any) => action.action === "closeMain").length), 1);
      await page.mouse.move(300, 400);
      await close.hover();
      assert.equal(await background(), "rgb(227, 76, 76)");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      assert.equal(await close.evaluate((button) => button.matches(":hover")), true);
      assert.equal(await background(), "rgba(0, 0, 0, 0)");
    } finally { await page.close(); }
  });
}

test("window controls preserve keyboard feedback and form focus on return", async () => {
  const page = await open();
  try {
    const maximize = page.getByRole("button", {name: "最大化或还原", exact: true});
    await maximize.focus();
    await page.keyboard.press("Enter");
    assert.equal(await maximize.evaluate((button) => document.activeElement === button && button.matches(":focus-visible")), true);
    assert.equal(await maximize.evaluate((button) => getComputedStyle(button).outlineStyle), "solid");
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.filter((action: any) => action.action === "maximize").length), 1);
    await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click();
    const title = page.getByRole("textbox", {name: "新任务标题", exact: true});
    await title.fill("尚未保存的标题");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
      (window as any).__fixture.emit("desktop://navigate", {});
    });
    assert.equal(await title.inputValue(), "尚未保存的标题");
    assert.equal(await title.evaluate((input) => document.activeElement === input), true);
  } finally { await page.close(); }
});

for (const theme of ["light", "dark"] as const) {
  test(`main window is interactive on ready and retained reopen (${theme})`, async () => {
    const state = fixture(); state.data.settings.theme = theme;
    const page = await open("", state);
    try {
      // Click as soon as ready is observed, without an animation completion or
      // host acknowledgement. An inert ancestor would make this time out.
      const add = page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true});
      await add.click({timeout: 1000});
      const title = page.getByRole("textbox", {name: "新任务标题", exact: true});
      await title.fill("窗口打开即可输入");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
        (window as any).__fixture.emit("desktop://navigate", {});
      });
      await title.fill("恢复后仍能继续输入");
      assert.equal(await title.inputValue(), "恢复后仍能继续输入");
      assert.equal(await page.locator("#main-window-surface").evaluate((node) => (node as HTMLElement).inert), false);
      assert.equal(await page.locator("#main-window-surface").evaluate((node) => node.getAnimations().length), 0);
      assert.equal(await page.evaluate(() => (window as any).__fixture.actions.filter((a: any) => a.action === "ready").length), 1);
    } finally { await page.close(); }
  });
}

test("native maximize and restore update the custom window corners", async () => {
  const page = await open();
  try {
    const surface = page.locator("#main-window-surface");
    await page.evaluate(() => (window as any).__fixture.emit("desktop://main-window-state", {maximized: true}));
    assert.equal(await surface.evaluate((node) => getComputedStyle(node).borderRadius), "0px");
    await page.evaluate(() => (window as any).__fixture.emit("desktop://main-window-state", {maximized: false}));
    assert.equal(await surface.evaluate((node) => getComputedStyle(node).borderRadius), "8px");
    await page.getByRole("button", {name: "添加任务 Ctrl+N", exact: true}).click({timeout: 1000});
    await page.getByRole("textbox", {name: "新任务标题", exact: true}).fill("还原后可编辑");
  } finally { await page.close(); }
});

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

for (const theme of ["light", "dark"] as const) {
  test(`floating input continues the native bar with one measured surface (${theme})`, async () => {
    const state = fixture(); state.data.settings.theme = theme;
    state.todayCount = 120; state.pendingCount = 3; state.reminderCount = 2;
    const page = await open("floating.html", state);
    try {
      const shell = page.locator(".floating-shell");
      await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "quickResize" && item.payload.width === 560 && item.payload.height === 40));
      assert.deepEqual(await shell.boundingBox(), {x: 0, y: 0, width: 560, height: 40});
      assert.equal(await page.getByRole("button", {name: "拖动悬浮栏"}).count(), 0);
      assert.deepEqual(await page.locator(".floating-form button").allTextContents(), ["今天 99+", "待确认 3", "提醒 2", "", ""]);
      for (const [name, width] of [["今天 99+", 100], ["待确认 3", 104], ["提醒 2", 80]] as const) {
        assert.equal((await page.getByRole("button", {name, exact: true}).boundingBox())?.width, width);
      }
      assert.deepEqual(await shell.evaluate((node) => ({shadow: getComputedStyle(node).boxShadow, corners: getComputedStyle(node).borderRadius})), {shadow: "none", corners: "8px"});
      await page.screenshot({path: `reports/quick-input-${theme}.png`, clip: {x: 0, y: 0, width: 560, height: 40}});
      const input = page.getByRole("textbox", {name: "快速添加任务"});
      await input.fill(Array(12).fill("这是一段需要换行并保留全文的长任务内容").join("\n"));
      await page.waitForFunction(() => (window as any).__fixture.actions.at(-1)?.action === "quickResize" && (window as any).__fixture.actions.at(-1)?.payload.height === 160);
      assert.equal((await input.boundingBox())?.height, 144);
      assert.deepEqual(await shell.boundingBox(), {x: 0, y: 0, width: 560, height: 160});
      await page.evaluate(() => {
        (window as any).__fixture.draftFailures = 1;
        (window as any).__fixture.emit("desktop://prepare-close", {window: "quick"});
      });
      await page.getByRole("status").waitFor();
      const bounds = await shell.boundingBox();
      const lastResize = await page.evaluate(() => (window as any).__fixture.actions.filter((item: any) => item.action === "quickResize").at(-1)?.payload);
      assert.deepEqual(lastResize, {width: bounds!.width, height: bounds!.height});
      assert.ok(bounds!.height > 160);
      const hint = await page.getByRole("status").boundingBox();
      assert.ok(hint!.y + hint!.height <= bounds!.height);
      await page.screenshot({path: `reports/quick-input-multiline-error-${theme}.png`, clip: {x: 0, y: 0, width: bounds!.width, height: bounds!.height}});
    } finally { await page.close(); }
  });
}

test("floating bar omits empty entries and short presses keep their navigation", async () => {
  const state = fixture(); state.pendingCount = 0;
  const page = await open("floating.html", state);
  try {
    assert.equal(await page.getByRole("button", {name: /待确认|提醒/}).count(), 0);
    await page.getByRole("button", {name: "今天 1", exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "openMain"));
    assert.deepEqual(await page.evaluate(() => (window as any).__fixture.actions.find((item: any) => item.action === "openMain").payload), {view: "today"});
  } finally { await page.close(); }
  const entries = fixture(); entries.reminderCount = 1;
  const entryPage = await open("floating.html", entries);
  try {
    await entryPage.getByRole("textbox", {name: "快速添加任务"}).fill("入口切换前的草稿");
    await entryPage.getByRole("button", {name: "提醒 1", exact: true}).click();
    assert.equal(await entryPage.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === "showReminders")), true);
    await entryPage.getByRole("button", {name: "待确认 2", exact: true}).click();
    await entryPage.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "openMain"));
    assert.deepEqual(await entryPage.evaluate(() => (window as any).__fixture.actions.find((item: any) => item.action === "openMain").payload), {view: "agent-review"});
    assert.equal(await entryPage.evaluate(() => (window as any).__fixture.draft.text), "入口切换前的草稿");
  } finally { await entryPage.close(); }
});

test("floating non-text areas drag across the threshold while text remains selectable", async () => {
  const state = fixture(); state.reminderCount = 1;
  const page = await open("floating.html", state);
  try {
    const input = page.getByRole("textbox", {name: "快速添加任务"});
    await input.fill("拖动后仍保留草稿，文本可以选择");
    const move = async (button: ReturnType<Page["getByRole"]>, dx: number) => {
      const box = (await button.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2);
      return () => page.mouse.up();
    };
    for (const name of ["今天 1", "待确认 2", "提醒 1", "添加任务", "收起输入"]) {
      const previous = await page.evaluate(() => (window as any).__fixture.actions.filter((item: any) => item.action === "quickDrag").length);
      const release = await move(page.getByRole("button", {name, exact: true}), 8);
      await page.waitForFunction((count) => (window as any).__fixture.actions.filter((item: any) => item.action === "quickDrag").length === count + 1, previous);
      await release();
    }
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => ["closeQuick", "openMain", "showReminders"].includes(item.action))), false);
    assert.equal(await page.evaluate(() => (window as any).__fixture.commands.length), 0);
    assert.equal(await page.evaluate(() => (window as any).__fixture.draft.text), "拖动后仍保留草稿，文本可以选择");
    const inputBox = (await input.boundingBox())!;
    await page.mouse.move(inputBox.x + 10, inputBox.y + 12);
    await page.mouse.down(); await page.mouse.move(inputBox.x + 100, inputBox.y + 12, {steps: 6}); await page.mouse.up();
    assert.ok(await input.evaluate((node) => node.selectionEnd > node.selectionStart));
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.filter((item: any) => item.action === "quickDrag").length), 5);
    const release = await move(page.getByRole("button", {name: "今天 1", exact: true}), 2);
    await release();
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === "openMain"));
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
function hierarchyFixture(): CoreSnapshot {
  const state = fixture();
  const ids = ["学校", "学校/数据结构", "学校/数据结构/作业", "学校/形势与政策", "学校/形势与政策/论文"];
  state.tagIndex = [
    {id: ids[0], name: "学校", parentId: null, path: ["学校"], rootId: ids[0], subtreeIds: ids},
    {id: ids[1], name: "数据结构", parentId: ids[0], path: ["学校", "数据结构"], rootId: ids[0], subtreeIds: [ids[1], ids[2]]},
    {id: ids[2], name: "作业", parentId: ids[1], path: ["学校", "数据结构", "作业"], rootId: ids[0], subtreeIds: [ids[2]]},
    {id: ids[3], name: "形势与政策", parentId: ids[0], path: ["学校", "形势与政策"], rootId: ids[0], subtreeIds: [ids[3], ids[4]]},
    {id: ids[4], name: "论文", parentId: ids[3], path: ["学校", "形势与政策", "论文"], rootId: ids[0], subtreeIds: [ids[4]]},
  ];
  state.data.settings.customTags = ids;
  state.data.settings.tagParents = {[ids[1]]: ids[0], [ids[2]]: ids[1], [ids[3]]: ids[0], [ids[4]]: ids[3]};
  state.data.tasks = [
    {...createTask({id: "structure", title: "完成链表作业", dueDate: localDate()}), tags: [ids[2]]},
    {...createTask({id: "policy", title: "撰写课程论文", dueDate: localDate()}), tags: [ids[4]]},
    {...createTask({id: "both", title: "整理课程材料", dueDate: localDate()}), tags: [ids[2], ids[4]]},
  ];
  return state;
}

for (const theme of ["light", "dark"] as const) {
  test(`nested tags show a collapsible tree, parent counts and full detail paths (${theme})`, async () => {
    const state = hierarchyFixture(); state.data.settings.theme = theme;
    const page = await open("", state);
    try {
      const tree = page.getByRole("tree", {name: "标签层级"});
      assert.equal(await tree.getByRole("button", {name: "展开标签 学校", exact: true}).count(), 1);
      assert.equal(await tree.locator('[data-nav-id="tag:学校/数据结构"]').count(), 0);
      await tree.getByRole("button", {name: "展开标签 学校", exact: true}).click();
      assert.equal(await tree.locator('[data-nav-id="tag:学校/数据结构/作业"]').count(), 0);
      await tree.getByRole("button", {name: "展开标签 学校 › 数据结构", exact: true}).click();
      assert.equal(await tree.locator('[data-nav-id="tag:学校/数据结构/作业"]').count(), 1);
      assert.equal(await tree.locator('[data-nav-id="tag:学校"] small').textContent(), "3");
      assert.equal(await tree.locator('[data-nav-id="tag:学校/数据结构"] small').textContent(), "2");
      await tree.locator('[data-nav-id="tag:学校"]').click();
      assert.equal(await page.locator('.task-row').count(), 3);
      const mixed = page.locator('.task-row[data-task-id="both"]');
      assert.deepEqual(await mixed.locator('.row-tag').allTextContents(), ["#学校"]);
      assert.equal(await mixed.locator('.row-tag').getAttribute('title'), "学校 › 数据结构 › 作业\n学校 › 形势与政策 › 论文");
      await tree.locator('[data-nav-id="tag:学校/数据结构"]').click();
      assert.equal(await page.locator('.task-row').count(), 2);
      await page.locator('.task-row[data-task-id="structure"]').click();
      const detail = page.getByRole('complementary', {name: '任务详情'});
      assert.equal(await detail.locator('.detail-tag-path').getAttribute('title'), '学校 › 数据结构 › 作业');
      const input = detail.getByRole('textbox', {name: '添加标签', exact: true});
      await input.fill('论文');
      const choice = detail.getByRole('option').filter({hasText: '形势与政策'});
      assert.equal(await choice.count(), 1);
      await choice.click();
      await page.waitForFunction(() => (window as any).__fixture.commands.some((command: any) => command.operation.type === 'taskUpdate'));
      const command = await page.evaluate(() => (window as any).__fixture.commands.find((command: any) => command.operation.type === 'taskUpdate').operation);
      assert.deepEqual(command.patch.tags, ['学校/数据结构/作业', '学校/形势与政策/论文']);
      await mkdir('.local/tag-hierarchy-20261102/web-evidence', {recursive: true});
      await page.screenshot({path: `.local/tag-hierarchy-20261102/web-evidence/hierarchy-${theme}.png`});
      await tree.getByRole('button', {name: '收起标签 学校', exact: true}).click();
      assert.equal(await tree.locator('[data-nav-id="tag:学校/数据结构"]').count(), 0);
    } finally { await page.close(); }
  });
}

test('tag management previews containment, blocks fourth-level parents and retains failed input', async () => {
  const page = await open('', hierarchyFixture());
  try {
    await page.getByRole('button', {name: '新建标签', exact: true}).click();
    const dialog = page.getByRole('form', {name: '添加标签', exact: true});
    await dialog.getByRole('textbox', {name: '标签名称'}).fill('实验');
    await dialog.getByRole('combobox', {name: '所属标签'}).selectOption('学校/数据结构');
    assert.match(await dialog.getByLabel('标签路径预览').textContent() || '', /学校 › 数据结构 › 实验/);
    assert.equal(await dialog.locator('option[value="学校/数据结构/作业"]').evaluate((option: HTMLOptionElement) => option.disabled), true);
    await page.evaluate(() => { (window as any).__fixture.failures.tagUpsert = 1; });
    await dialog.getByRole('button', {name: '添加', exact: true}).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('textbox', {name: '标签名称'}).inputValue(), '实验');
    assert.equal(await dialog.getByRole('combobox', {name: '所属标签'}).inputValue(), '学校/数据结构');
    const operation = await page.evaluate(() => (window as any).__fixture.commands.find((command: any) => command.operation.type === 'tagUpsert').operation);
    assert.deepEqual(operation, {type: 'tagUpsert', name: '实验', parent: '学校/数据结构', original: null});
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await page.getByRole('button', {name: '展开标签 学校', exact: true}).click();
    await page.getByRole('button', {name: '编辑标签 学校/数据结构', exact: true}).click();
    const edit = page.getByRole('form', {name: '编辑标签', exact: true});
    assert.equal(await edit.getByRole('textbox', {name: '标签名称'}).inputValue(), '数据结构');
    assert.equal(await edit.getByRole('combobox', {name: '所属标签'}).inputValue(), '学校');
    assert.equal(await edit.locator('option[value="学校/数据结构"]').count(), 0);
    assert.equal(await edit.locator('option[value="学校/数据结构/作业"]').count(), 0);
    assert.equal(await edit.locator('option[value="学校/形势与政策"]').evaluate((option: HTMLOptionElement) => option.disabled), true);
    assert.match(await edit.locator('.tag-delete-hint').textContent() || '', /1 个子标签.*任务会保留/);
  } finally { await page.close(); }
});

test('legacy tag names containing a slash stay flat in old snapshots', async () => {
  const state = fixture(); state.data.settings.customTags = ['学校/旧课程'];
  const page = await open('', state);
  try {
    const tree = page.getByRole('tree', {name: '标签层级'});
    assert.equal(await tree.locator('[data-nav-id="tag:学校/旧课程"]').textContent(), '学校/旧课程');
    assert.equal(await tree.getByRole('button', {name: /展开标签/}).count(), 0);
  } finally { await page.close(); }
});
for (const code of ['conflict', 'invalid_input']) {
  test(`a rejected tag draft can be cancelled and the window closed (${code})`, async () => {
    const page = await open('', hierarchyFixture());
    try {
      await page.evaluate((code) => { const f = (window as any).__fixture; f.failures.tagUpsert = 1; f.failureCodes.tagUpsert = code; }, code);
      await page.getByRole('button', {name: '新建标签', exact: true}).click();
      const dialog = page.getByRole('form', {name: '添加标签', exact: true});
      await dialog.getByRole('textbox', {name: '标签名称'}).fill(code === 'conflict' ? '学校' : '层级冲突');
      await dialog.getByRole('button', {name: '添加', exact: true}).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(await page.getByText('1 项操作尚未确认保存', {exact: true}).count(), 0);
      await dialog.getByRole('button', {name: '取消', exact: true}).click();
      await page.evaluate(() => (window as any).__fixture.emit('desktop://prepare-close', {window: 'main'}));
      await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain'));
    } finally { await page.close(); }
  });
}

test('a rejected new tag preserves the earlier storage failure through cancellation and retry', async () => {
  const page = await open('', hierarchyFixture());
  try {
    await page.evaluate(() => { const f = (window as any).__fixture; f.failures.tagUpsert = 2; f.failureCodes.tagUpsert = 'storage'; });
    await page.getByRole('button', {name: '新建标签', exact: true}).click();
    let dialog = page.getByRole('form', {name: '添加标签', exact: true});
    await dialog.getByRole('textbox', {name: '标签名称'}).fill('保留的标签草稿');
    await dialog.getByRole('button', {name: '添加', exact: true}).click();
    await dialog.getByRole('alert').waitFor();
    await page.getByText('1 项操作尚未确认保存', {exact: true}).waitFor();
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await page.evaluate(() => (window as any).__fixture.emit('desktop://prepare-close', {window: 'main'}));
    await page.getByText('还有未确认保存的操作，请先重试或放弃这些操作，再关闭。', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain')), false);
    await page.evaluate(() => { (window as any).__fixture.failureCodes.tagUpsert = 'conflict'; });
    await page.getByRole('button', {name: '新建标签', exact: true}).click();
    dialog = page.getByRole('form', {name: '添加标签', exact: true});
    await dialog.getByRole('textbox', {name: '标签名称'}).fill('学校');
    await dialog.getByRole('button', {name: '添加', exact: true}).click();
    await dialog.getByRole('alert').waitFor();
    await page.getByText('1 项操作尚未确认保存', {exact: true}).waitFor();
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    await page.evaluate(() => (window as any).__fixture.emit('desktop://prepare-close', {window: 'main'}));
    await page.getByText('还有未确认保存的操作，请先重试或放弃这些操作，再关闭。', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain')), false);
    await page.getByRole('button', {name: '新建标签', exact: true}).click();
    dialog = page.getByRole('form', {name: '添加标签', exact: true});
    await dialog.getByRole('textbox', {name: '标签名称'}).fill('独立的新标签');
    await dialog.getByRole('button', {name: '添加', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
    await page.getByText('1 项操作尚未确认保存', {exact: true}).waitFor();
    await page.getByRole('button', {name: '重试保存', exact: true}).click();
    await page.getByText('1 项操作尚未确认保存', {exact: true}).waitFor({state: 'detached'});
    const commands = await page.evaluate(() => (window as any).__fixture.commands.filter((item: any) => item.operation.type === 'tagUpsert'));
    assert.deepEqual(commands.map((item: any) => item.operation.name), ['保留的标签草稿', '学校', '独立的新标签', '保留的标签草稿']);
    assert.equal(commands[0].requestId, commands[3].requestId);
    await page.evaluate(() => (window as any).__fixture.emit('desktop://prepare-close', {window: 'main'}));
    await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain'));
  } finally { await page.close(); }
});
function dragHierarchyFixture(): CoreSnapshot {
  const state = hierarchyFixture();
  state.data.settings.customTags.push('生活', '读书');
  state.tagIndex.push(...['生活', '读书'].map((id) => ({id, name: id, parentId: null, path: [id], rootId: id, subtreeIds: [id]})));
  state.data.folders = [{id: 'study', name: '学习分组', sortOrder: 0}];
  state.data.lists.push(
    {id: 'school', name: '学校', color: '#4772fa', folderId: null, archived: false, sortOrder: 1},
    {id: 'structure', name: '数据结构', color: '#4772fa', folderId: null, parentListId: 'school', archived: false, sortOrder: 0},
    {id: 'homework', name: '作业', color: '#4772fa', folderId: null, parentListId: 'structure', archived: false, sortOrder: 0},
    {id: 'life', name: '生活', color: '#4772fa', folderId: null, archived: false, sortOrder: 2},
    {id: 'book', name: '读书', color: '#4772fa', folderId: null, archived: false, sortOrder: 3},
    {id: 'archived', name: '归档清单', color: '#4772fa', folderId: null, archived: true, sortOrder: 4},
  );
  state.listIndex = [
    {id: 'inbox', name: '收集箱', parentId: null, path: ['收集箱'], rootId: 'inbox', subtreeIds: ['inbox'], folderId: null},
    {id: 'school', name: '学校', parentId: null, path: ['学校'], rootId: 'school', subtreeIds: ['school', 'structure', 'homework'], folderId: null},
    {id: 'structure', name: '数据结构', parentId: 'school', path: ['学校', '数据结构'], rootId: 'school', subtreeIds: ['structure', 'homework'], folderId: null},
    {id: 'homework', name: '作业', parentId: 'structure', path: ['学校', '数据结构', '作业'], rootId: 'school', subtreeIds: ['homework'], folderId: null},
    ...['life', 'book', 'archived'].map((id) => ({id, name: id === 'life' ? '生活' : id === 'book' ? '读书' : '归档清单', parentId: null, path: [id === 'life' ? '生活' : id === 'book' ? '读书' : '归档清单'], rootId: id, subtreeIds: [id], folderId: null})),
  ];
  state.data.tasks[0].listId = 'homework';
  state.data.tasks[1].listId = 'structure';
  state.data.tasks[2].listId = 'school';
  return state;
}
async function beginHierarchyDrag(page: Page, navId: string) {
  const source = page.locator(`[data-nav-id="${navId}"]`);
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + Math.min(45, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(45, box.width / 2) + 12, box.y + box.height / 2, {steps: 3});
}
async function moveHierarchyDrag(page: Page, selector: string, fraction = .5) {
  const target = page.locator(selector).last();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + Math.min(60, box.width / 2), box.y + box.height * fraction, {steps: 6});
  await page.mouse.move(box.x + Math.min(60, box.width / 2), box.y + box.height * fraction);
}
async function hierarchyCommands(page: Page) {
  return page.evaluate(() => (window as any).__fixture.commands.filter((command: any) => ['tagMove', 'listMove'].includes(command.operation.type)));
}
for (const kind of ['tag', 'list'] as const) {
  test(`ordinary ${kind} drags distinguish inside, edge order, root and cancellation`, async () => {
    const page = await open('', dragHierarchyFixture());
    try {
      const source = kind === 'tag' ? 'tag:生活' : 'list:life';
      const target = kind === 'tag' ? 'tag:学校' : 'list:school';
      const wrapper = `[data-hierarchy-node="${target}"]`;
      await beginHierarchyDrag(page, source);
      await moveHierarchyDrag(page, wrapper);
      assert.equal(await page.locator(wrapper).getAttribute('data-drop-position'), 'inside');
      assert.equal(await page.locator(wrapper).getByText('移入', {exact: true}).count(), 1);
      assert.equal(await page.getByRole('region', {name: '整理导航'}).count(), 0);
      await mkdir('.local/hierarchy-drag-20261103/web-evidence', {recursive: true});
      await page.screenshot({path: `.local/hierarchy-drag-20261103/web-evidence/${kind}-inside.png`});
      await page.mouse.up();
      await page.waitForFunction(() => (window as any).__fixture.commands.some((command: any) => ['tagMove', 'listMove'].includes(command.operation.type)));
      let commands = await hierarchyCommands(page);
      assert.deepEqual(commands[0].operation, kind === 'tag' ? {type: 'tagMove', id: '生活', target: {kind: 'tag', tagId: '学校', position: 'inside'}} : {type: 'listMove', id: 'life', target: {kind: 'list', listId: 'school', position: 'inside'}});
      for (const [fraction, position] of [[.05, 'before'], [.95, 'after']] as const) {
        await beginHierarchyDrag(page, source);
        await moveHierarchyDrag(page, wrapper, fraction);
        assert.equal(await page.locator(wrapper).getAttribute('data-drop-position'), position);
        await page.mouse.up();
        commands = await hierarchyCommands(page);
        assert.equal(commands.at(-1).operation.target.position, position);
      }
      await beginHierarchyDrag(page, source);
      await moveHierarchyDrag(page, kind === 'tag' ? '[data-tag-drop-root="true"]' : '[data-list-drop-group="root"]');
      await page.mouse.up();
      commands = await hierarchyCommands(page);
      assert.deepEqual(commands.at(-1).operation.target, kind === 'tag' ? {kind: 'root'} : {kind: 'group', folderId: null});
      const count = commands.length;
      await beginHierarchyDrag(page, source);
      await moveHierarchyDrag(page, wrapper);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.equal((await hierarchyCommands(page)).length, count);
    } finally { await page.close(); }
  });
}

test('hierarchy drags refuse descendants and a fourth level; lists can leave for a folder', async () => {
  const page = await open('', dragHierarchyFixture());
  try {
    await page.getByRole('button', {name: '展开标签 学校', exact: true}).click();
    await page.getByRole('button', {name: '展开标签 学校 › 数据结构', exact: true}).click();
    await page.getByRole('button', {name: '展开清单 学校', exact: true}).click();
    await page.getByRole('button', {name: '展开清单 学校 › 数据结构', exact: true}).click();
    for (const [source, target] of [['tag:学校', 'tag:学校/数据结构'], ['tag:生活', 'tag:学校/数据结构/作业'], ['list:school', 'list:structure'], ['list:life', 'list:homework']]) {
      await beginHierarchyDrag(page, source);
      await moveHierarchyDrag(page, `[data-hierarchy-node="${target}"]`);
      assert.equal(await page.locator(`[data-hierarchy-node="${target}"]`).getAttribute('data-drop-position'), 'invalid');
      await page.mouse.up();
    }
    assert.equal((await hierarchyCommands(page)).length, 0);
    await beginHierarchyDrag(page, 'list:homework');
    await moveHierarchyDrag(page, '[data-list-drop-group="study"]');
    await page.mouse.up();
    assert.deepEqual((await hierarchyCommands(page))[0].operation, {type: 'listMove', id: 'homework', target: {kind: 'group', folderId: 'study'}});
  } finally { await page.close(); }
});

test('parent list views aggregate children and list selectors retain their paths', async () => {
  const page = await open('', dragHierarchyFixture());
  try {
    assert.equal(await page.locator('[data-nav-id="list:structure"]').count(), 0);
    assert.equal(await page.locator('[data-nav-id="list:school"] small').textContent(), '3');
    await page.locator('[data-nav-id="list:school"]').click();
    assert.equal(await page.locator('.task-row').count(), 3);
    await page.locator('.task-row[data-task-id="structure"]').click();
    assert.match(await page.locator('.destination-trigger').textContent() || '', /学校 › 数据结构 › 作业/);
    await page.getByRole('button', {name: '添加任务 Ctrl+N', exact: true}).click();
    const selector = page.getByRole('combobox', {name: '新任务所属清单', exact: true});
    assert.match(await selector.locator('option[value="homework"]').textContent() || '', /学校 › 数据结构 › 作业/);
    await page.getByRole('button', {name: '取消', exact: true}).click();
    await page.getByRole('button', {name: '编辑清单 学校', exact: true}).click();
    const dialog = page.getByRole('form', {name: '清单设置'});
    assert.match(await dialog.locator('.tag-delete-hint').textContent() || '', /直属子清单会提升一级/);
    assert.equal(await dialog.getByRole('combobox', {name: '所属父清单'}).locator('option[value="structure"]').count(), 0);
  } finally { await page.close(); }
});
for (const kind of ['tag', 'list'] as const) {
  for (const code of ['conflict', 'storage']) {
    test(`${kind} drag ${code} keeps the tree and preserves the correct close guard`, async () => {
      const page = await open('', dragHierarchyFixture());
      try {
        const type = kind === 'tag' ? 'tagMove' : 'listMove';
        await page.evaluate(({type, code}) => { const f = (window as any).__fixture; f.failures[type] = 1; f.failureCodes[type] = code; }, {type, code});
        const source = kind === 'tag' ? 'tag:生活' : 'list:life';
        const target = kind === 'tag' ? 'tag:学校' : 'list:school';
        await beginHierarchyDrag(page, source);
        await moveHierarchyDrag(page, `[data-hierarchy-node="${target}"]`);
        await page.mouse.up();
        await page.getByText('模拟保存失败，内容已保留', {exact: true}).waitFor();
        assert.equal(await page.locator(`[data-nav-id="${source}"]`).count(), 1);
        assert.equal(await page.locator('[data-nav-id="tag:学校/生活"]').count(), 0);
        assert.equal(await page.locator(`[data-hierarchy-node="${target}"]`).getAttribute('data-drop-position'), null);
        await page.evaluate(() => (window as any).__fixture.emit('desktop://prepare-close', {window: 'main'}));
        if (code === 'conflict') {
          await page.waitForFunction(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain'));
          assert.equal(await page.getByText('1 项操作尚未确认保存', {exact: true}).count(), 0);
        } else {
          await page.getByText('还有未确认保存的操作，请先重试或放弃这些操作，再关闭。', {exact: true}).waitFor();
          assert.equal(await page.evaluate(() => (window as any).__fixture.actions.some((item: any) => item.action === 'closeMain')), false);
          await page.getByRole('button', {name: '重试保存', exact: true}).click();
          await page.getByText('1 项操作尚未确认保存', {exact: true}).waitFor({state: 'detached'});
          const commands = await hierarchyCommands(page);
          assert.equal(commands[0].requestId, commands[1].requestId);
        }
      } finally { await page.close(); }
    });
  }
}

test('list parent editing clears a standalone folder and submits the chosen parent', async () => {
  const page = await open('', dragHierarchyFixture());
  try {
    await page.getByRole('button', {name: '编辑清单 生活', exact: true}).click();
    const dialog = page.getByRole('form', {name: '清单设置'});
    const parent = dialog.getByRole('combobox', {name: '所属父清单'});
    await parent.selectOption('school');
    assert.equal(await dialog.getByRole('combobox', {name: '清单分组'}).inputValue(), '');
    await dialog.getByRole('combobox', {name: '清单分组'}).selectOption('study');
    assert.equal(await parent.inputValue(), '');
    await parent.selectOption('school');
    await dialog.getByRole('button', {name: '保存', exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.some((command: any) => command.operation.type === 'collectionUpsert'));
    const operation = await page.evaluate(() => (window as any).__fixture.commands.find((command: any) => command.operation.type === 'collectionUpsert').operation);
    assert.equal(operation.value.id, 'life');
    assert.equal(operation.value.parentListId, 'school');
    assert.equal(operation.value.folderId, null);
  } finally { await page.close(); }
});
for (const destination of ['tag:学校', 'list:school']) {
  test(`task dragging to ${destination} keeps the task-move action`, async () => {
    const page = await open('', dragHierarchyFixture());
    try {
      await page.locator('.task-row[data-task-id="structure"]').dragTo(page.locator(`[data-nav-id="${destination}"]`));
      await page.waitForFunction(() => (window as any).__fixture.commands.some((command: any) => command.operation.type === 'taskMove'));
      const command = await page.evaluate(() => (window as any).__fixture.commands.find((command: any) => command.operation.type === 'taskMove').operation);
      assert.deepEqual(command, {type: 'taskMove', id: 'structure', view: destination});
      assert.equal((await hierarchyCommands(page)).length, 0);
      assert.equal(await page.getByRole('region', {name: '整理导航'}).count(), 0);
    } finally { await page.close(); }
  });
}

// Undo replays the inverse operation through the same core channel; the toast button and Ctrl+Z share one stack.
test('undo restores completion from the toast action and Ctrl+Z', async () => {
  const page = await open();
  try {
    const row = page.locator('.task-row[data-task-id="existing"]');
    await row.getByRole('button', {name: '完成 准备周报', exact: true}).click();
    const completes = () => page.evaluate(() => (window as any).__fixture.commands.filter((c: any) => c.operation.type === 'taskComplete'));
    await page.waitForFunction(() => (window as any).__fixture.commands.some((c: any) => c.operation.type === 'taskComplete'));
    assert.deepEqual((await completes())[0].operation, {type: 'taskComplete', id: 'existing', completed: true});
    assert.equal(await page.locator('.task-row[data-task-id="existing"]').count(), 0);
    await page.getByRole('button', {name: '撤销', exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.filter((c: any) => c.operation.type === 'taskComplete').length === 2);
    assert.deepEqual((await completes())[1].operation, {type: 'taskComplete', id: 'existing', completed: false});
    await page.locator('.task-row[data-task-id="existing"]').waitFor();
    // Ctrl+Z on a non-text target walks the same stack.
    await page.locator('.task-row[data-task-id="existing"]').getByRole('button', {name: '完成 准备周报', exact: true}).click();
    await page.waitForFunction(() => (window as any).__fixture.commands.filter((c: any) => c.operation.type === 'taskComplete').length === 3);
    await page.locator('.task-row[data-task-id="existing"]').waitFor({state: 'detached'});
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => (window as any).__fixture.commands.filter((c: any) => c.operation.type === 'taskComplete').length === 4);
    assert.deepEqual((await completes())[3].operation, {type: 'taskComplete', id: 'existing', completed: false});
    await page.locator('.task-row[data-task-id="existing"]').waitFor();
  } finally { await page.close(); }
});

test('Ctrl+Z inside a text field keeps the native text undo', async () => {
  const page = await open();
  try {
    await page.getByRole('button', {name: '添加任务 Ctrl+N', exact: true}).click();
    const title = page.getByRole('textbox', {name: '新任务标题', exact: true});
    await title.fill('会被撤销的标题');
    await title.focus();
    await page.keyboard.press('Control+z');
    assert.equal(await title.inputValue(), '');
    assert.equal(await page.evaluate(() => (window as any).__fixture.commands.some((c: any) => c.operation.type === 'taskComplete')), false);
  } finally { await page.close(); }
});
