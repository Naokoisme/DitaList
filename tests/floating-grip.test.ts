import assert from "node:assert/strict";
import test, {after, before} from "node:test";
import {mkdir} from "node:fs/promises";
import {chromium, type Browser} from "playwright";
import {createServer, type ViteDevServer} from "vite";
import {createEmptyData} from "../src/core/domain.ts";

// Production quick-entry component, with only IPC replaced. Native dragging and
// WebView destruction are verified separately in the actual Tauri candidate.
let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createServer({server: {host: "127.0.0.1", port: 0, strictPort: false, watch: {ignored: ["**/target/**", "**/.local/**", "**/reports/**"]}}});
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({headless: true, executablePath: process.env.DITALIST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"});
  await mkdir("reports/floating-feedback-20261030", {recursive: true});
});
after(async () => { await browser?.close(); await server?.close(); });

for (const [theme, width] of [["light", 440], ["dark", 320]] as const) {
  test(`quick grip separates click, jitter, and drag; ${theme}, ${width}px`, async () => {
    const page = await browser.newPage({viewport: {width, height: 160}});
    const data = createEmptyData(); data.settings.theme = theme;
    await page.addInitScript((data) => {
      const callbacks = new Map<number, Function>(); let next = 1;
      const f = (window as any).__floatingFixture = {actions: [] as any[], draft: {text: "保留草稿", requestId: null}, draftFailure: false, commands: [] as any[]};
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback(callback: Function) { const id = next++; callbacks.set(id, callback); return id; },
        unregisterCallback(id: number) { callbacks.delete(id); },
        async invoke(command: string, args: any) {
          if (command === "plugin:event|listen") return args.handler;
          if (command === "plugin:event|unlisten") return;
          if (command === "core_snapshot") return {data, revision: 1, entityVersions: {}, approvals: [], reminders: [], todayCount: 0, pendingCount: 0, reminderCount: 0, preferences: {floatingVisible: true, quiet: false, mcpEnabled: false, confirmPurge: true}, focus: {mode: "focus", running: false, taskId: null, title: "", startedAt: null, deadline: null, remainingSeconds: 1500, elapsedSeconds: 0, targetSeconds: 1500}};
          if (command === "draft_get") return f.draft;
          if (command === "draft_set") { if (f.draftFailure) throw new Error("草稿保存失败"); f.draft = args.draft; return; }
          if (command === "desktop_action") { f.actions.push(args); return; }
          if (command === "core_execute") { f.commands.push(args.command); return; }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      };
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener(_event: string, id: number) { callbacks.delete(id); }};
    }, data);
    try {
      await page.goto(`${url}floating.html`);
      const input = page.getByRole("textbox", {name: "快速添加任务"});
      await input.waitFor();
      await page.waitForFunction(() => (window as any).__floatingFixture.actions.some((a: any) => a.action === "ready"));
      const grip = page.getByRole("button", {name: "拖动悬浮栏", exact: true});
      await grip.click();
      assert.equal(await input.inputValue(), "保留草稿");
      assert.equal(await input.evaluate((el) => el === document.activeElement), true);
      await grip.focus(); await grip.press("Enter"); await grip.press("Space");
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.actions.some((a: any) => a.action === "quickDrag" || a.action === "closeQuick")), false);
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.commands.length), 0);
      const bounds = (await grip.boundingBox())!;
      await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down();
      await page.mouse.move(bounds.x + 22, bounds.y + 21);
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.actions.some((a: any) => a.action === "quickDrag")), false);
      await page.mouse.move(bounds.x + 26, bounds.y + 20);
      await page.waitForFunction(() => (window as any).__floatingFixture.actions.some((a: any) => a.action === "quickDrag"));
      await page.mouse.move(bounds.x + 36, bounds.y + 20); await page.mouse.up();
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.actions.filter((a: any) => a.action === "quickDrag").length), 1);
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.draft.text), "保留草稿");
      await page.screenshot({path: `reports/floating-feedback-20261030/web-quick-${theme}.png`});
      await page.evaluate(() => { const f = (window as any).__floatingFixture; f.actions = []; f.draftFailure = true; });
      await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down();
      await page.mouse.move(bounds.x + 30, bounds.y + 20); await page.mouse.up();
      await page.getByRole("status").filter({hasText: "草稿保存失败"}).waitFor();
      assert.equal(await page.evaluate(() => (window as any).__floatingFixture.actions.some((a: any) => a.action === "quickDrag")), false);
      assert.equal(await input.inputValue(), "保留草稿");
    } finally { await page.close(); }
  });
}
