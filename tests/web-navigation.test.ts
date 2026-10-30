import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { mkdir } from "node:fs/promises";

// The production navigation component runs with fixture callbacks; desktop gesture
// delivery and durable Rust saves remain separate acceptance checks.
let server: ViteDevServer;
let browser: Browser;
let url: string;
const componentFixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AppNavigation from "/src/components/AppNavigation.tsx";
import { createEmptyData } from "/src/core/domain.ts";
import "/src/styles.css";
const f = window.__navigationFixture = { actions: [], saves: [], editing: [], fail: false, waitSave: false, releaseSave: null };
function Fixture() {
  const [data, setData] = useState(() => {
    const data = createEmptyData();
    data.lists.push({id: "work", name: "工作清单", color: "#4772d1", folderId: null, archived: false, sortOrder: 1});
    data.settings.navigation = { orders: {}, hidden: window.__hidden || [] };
    return data;
  });
  const [view, setView] = useState("all");
  const go = (id) => { f.actions.push(id); setView(id); };
  return <div className="app-shell"><AppNavigation data={data} view={view} active={[]} tags={["工作"]}
    saveStatus="saved" saveStatusLabel="已保存" sidebarOpen={false} draggingListId={null} listDropTarget={null}
    onGo={go} onSettings={(section) => f.actions.push("settings:" + section)} onSearch={() => f.actions.push("search")} onHelp={() => f.actions.push("help")}
    onAgentReview={() => go("agent-review")} todayCount={0} pendingCount={2}
    onCloseSidebar={() => {}} onAddList={() => {}} onAddFolder={() => {}} onAddTag={() => {}} onAddFilter={() => {}}
    onEditingChange={(editing) => f.editing.push(editing)}
    onSaveNavigation={async (preferences) => { f.saves.push(structuredClone(preferences));
      if (f.waitSave) await new Promise((resolve) => { f.releaseSave = resolve; });
      if (f.fail) return false;
      setData((before) => ({...before, settings: {...before.settings, navigation: preferences}})); return true; }}
    listGroupDropProps={() => ({})}
    renderSidebarItem={(id, label, Icon) => <button className={"sidebar-item " + (view === id ? "selected" : "")} onClick={() => go(id)}><Icon size={17}/><span>{label}</span></button>}
    renderListItem={(list) => <button className="sidebar-item" draggable onDragStart={(event) => event.dataTransfer.setData("text/dida-list", list.id)} onClick={() => go("list:" + list.id)}
      onDoubleClick={() => f.actions.push("edit-list:" + list.id)} onContextMenu={(event) => { event.preventDefault(); f.actions.push("menu-list:" + list.id); }}>{list.name}</button>}
    renderTagItem={(tag) => <button className="sidebar-item" onClick={() => go("tag:" + tag)}
      onDoubleClick={() => f.actions.push("edit-tag:" + tag)} onContextMenu={(event) => { event.preventDefault(); f.actions.push("menu-tag:" + tag); }}>{tag}</button>}
  /><main className="main-content"><h1>{view}</h1></main></div>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;

before(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/target/**", "**/.local/**", "**/reports/**"] } },
    plugins: [{ name: "navigation-component-fixture",
      resolveId(id) { if (id === "/__navigation_fixture.tsx") return id; },
      load(id) { if (id === "/__navigation_fixture.tsx") return componentFixture; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__navigation_fixture.html") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__navigation_fixture.tsx"></script></body></html>'));
      }); },
    }],
  });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.DITALIST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" });
  await mkdir("reports/navigation-feedback", { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(hidden: string[] = []): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1140, height: 780 } });
  await page.addInitScript((value) => { (window as any).__hidden = value; }, hidden);
  await page.goto(`${url}__navigation_fixture.html`);
  await page.locator(".navigation-settings").waitFor();
  return page;
}
async function hold(page: Page, id: string, release = true) {
  const bounds = (await page.locator(`[data-navigation-id="${id}"]`).boundingBox())!;
  await page.mouse.move(bounds.x + Math.min(70, bounds.width / 2), bounds.y + 17);
  await page.mouse.down();
  await page.waitForTimeout(560);
  if (release) await page.mouse.up();
  await page.getByRole("region", { name: "整理导航" }).waitFor();
}
async function order(page: Page) {
  return page.locator('[data-navigation-group="sidebar"]').evaluateAll((elements) => elements.map((item) => (item as HTMLElement).dataset.navigationId));
}

test("settings is a fixed gear and short clicks remain navigation", async () => {
  const page = await open(["rail:settings"]);
  try {
    assert.equal(await page.locator(".navigation-settings svg.lucide-settings").count(), 1);
    assert.equal(await page.getByRole("button", { name: "编辑导航", exact: true }).count(), 0);
    await page.locator(".navigation-settings").click();
    await page.getByRole("button", { name: "今天", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), ["settings:general", "today"]);
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 0);
  } finally { await page.close(); }
});

test("long hold continues into a drag, suppresses clicks, and saves Agent ordering", async () => {
  const page = await open();
  try {
    await hold(page, "agent-review", false);
    const destination = (await page.locator('[data-navigation-id="today"]').boundingBox())!;
    await page.mouse.move(destination.x + 70, destination.y + destination.height - 4, { steps: 8 });
    assert.equal(await page.locator('[data-navigation-id="today"].drop-after').count(), 1);
    await page.mouse.up();
    assert.deepEqual((await order(page)).slice(0, 3), ["today", "agent-review", "next7"]);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), []);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.saves[0].orders.sidebar.slice(0, 3)), ["today", "agent-review", "next7"]);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.editing), [true, false]);
  } finally { await page.close(); }
});

test("hidden lists, tags and rail entries are recoverable inline with a light and dark preview", async () => {
  const page = await open(["list:work", "tag:工作", "rail:calendar"]);
  try {
    assert.equal(await page.getByRole("button", { name: "日历", exact: true }).count(), 0);
    await hold(page, "next7");
    await page.getByRole("button", { name: "显示工作清单", exact: true }).click();
    await page.getByRole("button", { name: "显示工作", exact: true }).click();
    await page.getByRole("button", { name: "显示日历", exact: true }).click();
    await page.getByRole("button", { name: "隐藏最近7天", exact: true }).click();
    await page.screenshot({ path: "reports/navigation-feedback/inline-edit-light.png" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: "reports/navigation-feedback/inline-edit-dark.png" });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "最近7天", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "工作清单", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "日历", exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.saves[0].hidden), ["next7"]);
  } finally { await page.close(); }
});

test("failed save stays in place; Escape cancels and normal clicks work again", async () => {
  const page = await open();
  try {
    await hold(page, "today");
    await page.getByRole("button", { name: "隐藏今天", exact: true }).click();
    await page.evaluate(() => { (window as any).__navigationFixture.fail = true; });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 0);
    await page.getByRole("button", { name: "今天", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), ["today"]);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.editing), [true, false]);
  } finally { await page.close(); }
});

test("moving before the hold threshold does not enter edit mode", async () => {
  const page = await open();
  try {
    const rect = (await page.locator('[data-navigation-id="today"]').boundingBox())!;
    await page.mouse.move(rect.x + 50, rect.y + 17);
    await page.mouse.down();
    await page.mouse.move(rect.x + 70, rect.y + 17, { steps: 2 });
    await page.waitForTimeout(560);
    await page.mouse.up();
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__navigationFixture.saves.length), 0);
  } finally { await page.close(); }
});

test("Escape during a held drag cancels without navigating on release", async () => {
  const page = await open();
  try {
    await hold(page, "today", false);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    await page.mouse.up();
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), []);
    await page.getByRole("button", { name: "今天", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), ["today"]);
  } finally { await page.close(); }
});

test("organizing suppresses list and tag double-clicks and context menus", async () => {
  const page = await open();
  try {
    const list = page.getByRole("button", { name: "工作清单", exact: true });
    const tag = page.getByRole("button", { name: "工作", exact: true });
    await list.dblclick();
    await list.click({ button: "right" });
    await tag.dblclick();
    await tag.click({ button: "right" });
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions.filter((item: string) => item.startsWith("edit-") || item.startsWith("menu-"))), ["edit-list:work", "menu-list:work", "edit-tag:工作", "menu-tag:工作"]);
    await page.evaluate(() => { (window as any).__navigationFixture.actions = []; });
    await hold(page, "today");
    await list.dblclick();
    await list.click({ button: "right" });
    await tag.dblclick();
    await tag.click({ button: "right" });
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.actions), []);
    assert.equal(await page.getByRole("region", { name: "整理导航" }).count(), 1);
  } finally { await page.close(); }
});

test("saving freezes keyboard reordering until the accepted layout is persisted", async () => {
  const page = await open();
  try {
    await hold(page, "today");
    const today = page.locator('[data-navigation-id="today"]');
    await today.focus();
    await page.keyboard.press("Alt+ArrowDown");
    const submitted = await order(page);
    assert.deepEqual(submitted.slice(0, 4), ["agent-review", "next7", "today", "inbox"]);
    await page.evaluate(() => { (window as any).__navigationFixture.waitSave = true; });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).__navigationFixture.releaseSave === "function");
    await today.focus();
    await page.keyboard.press("Alt+ArrowDown");
    assert.deepEqual(await order(page), submitted);
    assert.equal(await page.getByRole("button", { name: "取消", exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.saves[0].orders.sidebar), submitted);
    await page.evaluate(() => (window as any).__navigationFixture.releaseSave());
    await page.getByRole("region", { name: "整理导航" }).waitFor({ state: "detached" });
    assert.deepEqual(await order(page), submitted);
    assert.deepEqual(await page.evaluate(() => (window as any).__navigationFixture.editing), [true, false]);
  } finally { await page.close(); }
});
