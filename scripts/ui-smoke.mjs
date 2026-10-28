import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, _electron } from 'playwright';

// Runs the built production components in a separate, headless Chrome profile.
// No user Chrome profile, desktop window, CUA session or original Dida data is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onlyElectron = process.argv.includes('--electron-only');
const withElectron = onlyElectron || process.argv.includes('--electron');
const targeted = process.argv.includes('--targeted');
const packagedExecutable = process.env.DIDA_UI_ELECTRON_EXE;
const dist = packagedExecutable && onlyElectron ? path.join(path.dirname(packagedExecutable), 'resources', 'app', 'dist') : path.join(root, 'dist');
const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-:]/g, '').replace(' ', '-');
const reportDir = path.resolve(process.env.DIDA_UI_REPORT_DIR || path.join(root, 'reports', 'ui-smoke', timestamp));
const chrome = process.env.DIDA_UI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const report = { startedAt: new Date().toISOString(), engine: onlyElectron ? 'Electron hidden window; isolated data directory' : 'Chrome headless; isolated persistent profile', production: true, cases: [], screenshots: [], pageErrors: [], externalRequests: [], limitations: ['Browser responsive layout does not establish Android native device acceptance.', 'Desktop disk-backed persistence is established only by the separately recorded Electron case.'] };
await fs.access(path.join(dist, 'index.html'));
await fs.mkdir(reportDir, { recursive: true });
report.build = [];
const buildSnapshot = new Map();
async function buildFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await buildFiles(path.join(directory, entry.name), name + '/'));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}
for (const file of await buildFiles(dist)) {
  const bytes = await fs.readFile(path.join(dist, file));
  buildSnapshot.set(path.resolve(dist, file), bytes);
  report.build.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
    const content = buildSnapshot.get(target);
    if (!content) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
report.origin = origin;
const launchOptions = { executablePath: chrome, headless: true, viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN', acceptDownloads: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run'] };
const profile = path.join(reportDir, 'chrome-profile');
let context;
let page;
let fatal;
const updateReport = () => fs.writeFile(path.join(reportDir, 'result.json'), JSON.stringify(report, null, 2));
async function screenshot(name) {
  const file = path.join(reportDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled', timeout: 10000 });
  report.screenshots.push(file);
  return file;
}
async function attach(testContext) {
  await testContext.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    report.externalRequests.push(url);
    return route.abort();
  });
  const p = testContext.pages()[0] || await testContext.newPage();
  p.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
  p.setDefaultTimeout(8000);
  return p;
}
async function saved() {
  await page.locator('.save-indicator.saved').waitFor({ state: 'attached' });
}
async function productState() {
  await saved();
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('dida-local-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('documents', 'readonly').objectStore('documents').get('main');
      read.onsuccess = () => { database.close(); resolve(read.result); };
      read.onerror = () => { database.close(); reject(read.error); };
    };
  }));
}
async function step(name, action) {
  const started = Date.now();
  try { const evidence = await action(); report.cases.push({ name, status: 'passed', elapsedMs: Date.now() - started, evidence }); console.log(`PASS ${name}`); }
  catch (error) {
    const image = await screenshot(`failure-${report.cases.length + 1}`).catch(() => null);
    report.cases.push({ name, status: 'failed', elapsedMs: Date.now() - started, error: error.stack || String(error), screenshot: image });
    console.log(`FAIL ${name}: ${error.message}`);
    // Keep later independent cases from inheriting a modal left open by a failed case.
    await page?.keyboard.press('Escape').catch(() => {});
  }
  await updateReport();
}
const navigation = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });
async function closeDetail() { const button = page.getByRole('button', { name: '关闭任务详情', exact: true }); if (await button.isVisible()) await button.click(); }
async function quickAdd(text) { const field = page.getByRole('textbox', { name: '添加任务', exact: true }); await field.fill(text); await field.press('Enter'); await page.getByRole('textbox', { name: '任务标题', exact: true }).waitFor(); }
async function createTask(title, date, content = '') {
  await page.keyboard.press('Control+n');
  await page.getByRole('textbox', { name: '新任务标题', exact: true }).fill(title);
  await page.getByRole('textbox', { name: '新任务描述', exact: true }).fill(content);
  await page.getByLabel('新任务日期', { exact: true }).fill(date);
  await page.locator('.new-task-dialog').getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).waitFor();
}
async function openSettings() { await page.locator('button[aria-label="设置"]:visible').first().click(); await page.locator('.settings-dialog').waitFor(); }
async function theme(value) {
  await openSettings();
  await page.locator('.settings-nav').getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: value === 'dark' ? '深色' : '浅色', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), value);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
}
async function noHorizontalOverflow() {
  const value = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(value.document <= value.viewport + 1 && value.body <= value.viewport + 1, JSON.stringify(value));
  return value;
}
const addDays = (value, amount) => { const d = new Date(`${value}T12:00:00`); d.setDate(d.getDate() + amount); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function targetedBrowserCases(today, month) {
  let timedTaskId;
  let movedDay = `${month}-01`;
  await step('时段双击新建预填小时与15分钟拖移', async () => {
    await navigation('日历').click(); await page.getByLabel('选择日历月份', { exact: true }).fill(month);
    await page.locator(`.cal-mini-dates button[aria-label="${month}-01"]`).click();
    await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '日', exact: true }).click();
    const ninthHour = page.locator('.cal-time-column').first().locator('.cal-hour-cell').nth(9);
    await ninthHour.dblclick({ position: { x: 120, y: 20 } });
    assert.equal(await page.getByLabel('新任务日期', { exact: true }).inputValue(), `${month}-01`);
    assert.equal(await page.getByLabel('新任务时间', { exact: true }).inputValue(), '09:00');
    await page.getByRole('textbox', { name: '新任务标题', exact: true }).fill('时段拖移任务');
    await page.locator('.new-task-dialog').getByRole('button', { name: '添加', exact: true }).click(); await closeDetail();
    const state = await productState(); timedTaskId = state.tasks.find(task => task.title === '时段拖移任务').id;
    const target = page.locator('.cal-time-column').first().locator('.cal-hour-cell').nth(10);
    await page.locator('.cal-event').filter({ hasText: '时段拖移任务' }).dragTo(target, { targetPosition: { x: 100, y: 31 } });
    const task = (await productState()).tasks.find(item => item.id === timedTaskId);
    assert.equal(task.dueDate, `${month}-01`); assert.equal(task.time, '10:30');
    return { taskId: timedTaskId, date: task.dueDate, time: task.time };
  });
  await step('周视图跨日改时与拖入全天清除时刻', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '周', exact: true }).click();
    const sourceIndex = (new Date(`${month}-01T12:00:00`).getDay() + 6) % 7;
    const targetIndex = sourceIndex < 6 ? sourceIndex + 1 : sourceIndex - 1;
    movedDay = addDays(`${month}-01`, targetIndex - sourceIndex);
    const target = page.locator('.cal-time-column').nth(targetIndex).locator('.cal-hour-cell').nth(11);
    await page.locator('.cal-event').filter({ hasText: '时段拖移任务' }).dragTo(target, { targetPosition: { x: 35, y: 16 } });
    let task = (await productState()).tasks.find(item => item.id === timedTaskId);
    assert.equal(task.dueDate, movedDay); assert.equal(task.time, '11:15');
    await page.locator('.cal-event').filter({ hasText: '时段拖移任务' }).dragTo(page.locator('.cal-time-allday-cell').nth(targetIndex));
    task = (await productState()).tasks.find(item => item.id === timedTaskId);
    assert.equal(task.dueDate, movedDay); assert.equal(task.time, null); assert.equal(task.endTime, null);
    return { date: task.dueDate, time: task.time, endTime: task.endTime };
  });
  await step('跨日新建拒绝倒序日期且保留有效输入', async () => {
    await page.keyboard.press('Escape');
    await page.locator(`.cal-mini-dates button[aria-label="${month}-01"]`).click();
    await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '月', exact: true }).click();
    await page.getByLabel('选择日历月份', { exact: true }).fill(month);
    const start = await page.locator(`.cal-day[data-date="${month}-15"]`).boundingBox();
    const end = await page.locator(`.cal-day[data-date="${month}-17"]`).boundingBox();
    const before = (await productState()).tasks.length;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height - 14); await page.mouse.down();
    await page.waitForTimeout(460); // A real long-press gesture crosses the component's hold threshold.
    await page.mouse.move(end.x + end.width / 2, end.y + end.height - 14); await page.mouse.up();
    await page.getByRole('textbox', { name: '新任务标题', exact: true }).fill('跨日范围验收');
    await page.getByLabel('新任务日期', { exact: true }).fill(`${month}-14`);
    await page.locator('.new-task-dialog').getByRole('button', { name: '添加', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '结束日期不能早于开始日期' }).waitFor();
    assert.equal((await productState()).tasks.length, before);
    assert.equal(await page.getByRole('textbox', { name: '新任务标题', exact: true }).inputValue(), '跨日范围验收');
    await page.getByLabel('新任务日期', { exact: true }).fill(`${month}-17`);
    await page.locator('.new-task-dialog').getByRole('button', { name: '添加', exact: true }).click();
    const task = (await productState()).tasks.find(item => item.title === '跨日范围验收');
    assert.equal(task.startDate, `${month}-15`); assert.equal(task.dueDate, `${month}-17`); await closeDetail();
  });
  await step('复制周期任务形成独立系列与独立子任务', async () => {
    await navigation('任务').click(); await page.locator('.app-sidebar').getByRole('button', { name: /^收集箱/ }).click();
    await quickAdd('每天 原始周期任务');
    const input = page.getByRole('textbox', { name: '添加子任务', exact: true }); await input.fill('独立子任务'); await input.press('Enter');
    await page.getByRole('button', { name: '完成任务', exact: true }).click(); await closeDetail();
    let state = await productState(); const original = state.tasks.find(task => task.title === '原始周期任务' && !task.completedAt);
    assert.ok(original.recurrenceId);
    await page.locator(`[data-task-id="${original.id}"]`).click({ button: 'right' });
    await page.locator('.context-menu').getByRole('button', { name: '复制任务', exact: true }).click();
    state = await productState(); const copy = state.tasks.find(task => task.title === '原始周期任务（副本）');
    assert.equal(copy.recurrenceId, undefined); assert.notEqual(copy.subtasks[0].id, original.subtasks[0].id);
    await page.locator(`[data-task-id="${original.id}"]`).getByRole('button', { name: '完成 原始周期任务', exact: true }).click();
    await page.locator(`[data-task-id="${copy.id}"]`).getByRole('button', { name: '完成 原始周期任务（副本）', exact: true }).click();
    state = await productState();
    const nextOriginal = state.tasks.filter(task => task.title === original.title && !task.completedAt);
    const nextCopy = state.tasks.filter(task => task.title === copy.title && !task.completedAt);
    assert.equal(nextOriginal.length, 1); assert.equal(nextCopy.length, 1);
    assert.equal(nextOriginal[0].dueDate, addDays(today, 2)); assert.equal(nextCopy[0].dueDate, addDays(today, 2));
    assert.notEqual(nextCopy[0].recurrenceId, nextOriginal[0].recurrenceId);
    return { originalSeries: nextOriginal[0].recurrenceId, copiedSeries: nextCopy[0].recurrenceId };
  });
  await step('详情标题允许暂空并在10000字边界保存', async () => {
    await createTask('标题编辑边界', today);
    const title = page.getByRole('textbox', { name: '任务标题', exact: true });
    await title.fill(''); await title.fill('长'.repeat(10000) + '超限');
    assert.equal((await title.inputValue()).length, 10000);
    await page.getByRole('textbox', { name: '任务描述', exact: true }).click();
    let state = await productState(); assert.equal(state.tasks.find(task => task.title.length === 10000).title.length, 10000);
    assert.equal(await page.locator('.save-indicator.error').count(), 0);
    await title.fill('标题边界已验证'); await closeDetail();
    state = await productState(); assert.ok(state.tasks.some(task => task.title === '标题边界已验证'));
  });
  await step('专注目标冻结与暂停切换模式保留投入时间', async () => {
    await openSettings(); await page.locator('.settings-nav').getByRole('button', { name: '专注', exact: true }).click();
    await page.getByLabel('番茄专注时长（分钟）', { exact: true }).fill('1');
    await page.getByLabel('专注完成提示音', { exact: true }).uncheck();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await navigation('专注').click();
    await page.clock.install({ time: new Date() });
    await page.locator('.timer-start').click(); await page.clock.fastForward(10000);
    await openSettings(); await page.locator('.settings-nav').getByRole('button', { name: '专注', exact: true }).click();
    await page.getByLabel('番茄专注时长（分钟）', { exact: true }).fill('2');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await navigation('任务').click(); await page.clock.fastForward(55000); await navigation('专注').click();
    await page.locator('.focus-message').filter({ hasText: '本次专注已完成' }).waitFor();
    let state = await productState(); const completed = state.focusSessions.filter(session => session.completed);
    assert.equal(completed.length, 1); assert.equal(completed[0].durationSeconds, 60, '运行中改为2分钟不改变本次1分钟目标');
    await page.locator('.timer-start').click(); await page.clock.fastForward(15000); await page.locator('.timer-start').click();
    await page.locator('.focus-tabs').getByRole('button', { name: '休息', exact: true }).click();
    state = await productState(); const interrupted = state.focusSessions.filter(session => !session.completed);
    assert.equal(interrupted.length, 1); assert.ok(interrupted[0].durationSeconds >= 15 && interrupted[0].durationSeconds < 30);
    await page.clock.resume(); return { completedSeconds: completed[0].durationSeconds, pausedSeconds: interrupted[0].durationSeconds, simulatedAdvanceSeconds: 80 };
  });
  await step('最终浅深月历文字对比与手机生产截图', async () => {
    await navigation('日历').click(); await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '月', exact: true }).click();
    await page.getByLabel('选择日历月份', { exact: true }).fill(month);
    const closeToast = page.getByRole('button', { name: '关闭提示', exact: true }); if (await closeToast.isVisible()) await closeToast.click();
    const event = page.locator('.cal-event').filter({ hasText: '时段拖移任务' }).first();
    const colors = {};
    for (const value of ['light', 'dark']) {
      await theme(value);
      const measured = await event.evaluate(element => {
        const parse = color => { const values = color.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return [values[0], values[1], values[2], values.length > 3 ? values[3] : 1]; };
        const over = (top, bottom) => [0, 1, 2].map(index => top[index] * top[3] + bottom[index] * (1 - top[3])).concat(1);
        const layers = []; for (let current = element; current; current = current.parentElement) layers.push(parse(getComputedStyle(current).backgroundColor));
        let background = [255, 255, 255, 1]; for (const layer of layers.reverse()) background = over(layer, background);
        const rawColor = getComputedStyle(element).color; const foreground = over(parse(rawColor), background);
        const luminance = color => color.slice(0, 3).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
        const first = luminance(foreground), second = luminance(background);
        return { text: rawColor, foreground, background, contrast: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
      });
      assert.ok(measured.contrast >= 4.5, `${value}: ${JSON.stringify(measured)}`); colors[value] = measured;
      await screenshot(`final-desktop-calendar-${value}`);
      await page.setViewportSize({ width: 390, height: 844 }); await noHorizontalOverflow(); await screenshot(`final-mobile-calendar-${value}`);
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    await theme('light'); return colors;
  });
  await step('新增边界无页面异常与外部网络', async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); });
}

try {
  if (!onlyElectron) {
  context = await chromium.launchPersistentContext(profile, launchOptions);
  page = await attach(context);
  report.browserVersion = context.browser()?.version();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.app-shell').waitFor();
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const month = today.slice(0, 7);
  let planningTaskId;
  let importedBackup;
  if (targeted) await targetedBrowserCases(today, month);
  else {
  await step('空白启动与数据隔离', async () => { const s = await productState(); assert.equal(s.tasks.length, 0); assert.equal(s.lists.length, 1); assert.equal(s.settings.theme, 'light'); await screenshot('desktop-empty-light'); return await noHorizontalOverflow(); });
  await step('今天快速输入尊重明天日期', async () => {
    await quickAdd('明天 10:00 处理测试邮件 #工作 !2');
    const s = await productState(); const task = s.tasks.find(t => t.title === '处理测试邮件');
    assert.ok(task); assert.equal(task.dueDate, addDays(today, 1)); assert.equal(task.time, '10:00'); assert.equal(task.priority, 2); assert.deepEqual(task.tags, ['工作']);
    return { task: { title: task.title, dueDate: task.dueDate, time: task.time, priority: task.priority, tags: task.tags } };
  });
  await closeDetail();
  await step('创建自定义清单', async () => {
    await page.getByRole('button', { name: '添加清单', exact: true }).click();
    await page.getByRole('textbox', { name: '清单名称', exact: true }).fill('产品计划');
    await page.locator('.list-dialog').getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('heading', { name: '产品计划', exact: true, level: 1 }).waitFor();
    const s = await productState(); assert.ok(s.lists.some(l => l.name === '产品计划'));
  });
  await step('任务详情、子任务、标签、日期与重复', async () => {
    await quickAdd('核对原版月视图 #设计 !1');
    const description = page.getByRole('textbox', { name: '任务描述', exact: true });
    await description.fill('核对任务与日历的一致性\n验收数据只写入隔离目录。');
    const subtask = page.getByRole('textbox', { name: '添加子任务', exact: true });
    await subtask.fill('检查跨日显示'); await subtask.press('Enter');
    await page.getByRole('button', { name: '完成子任务 检查跨日显示', exact: true }).click();
    const tag = page.getByRole('textbox', { name: '添加标签', exact: true }); await tag.fill('验收'); await tag.press('Enter');
    await page.locator('.detail-date').click();
    await page.getByLabel('截止日期', { exact: true }).fill(`${month}-17`);
    await page.getByLabel('开始日期', { exact: true }).fill(`${month}-15`);
    await page.getByLabel('任务时间', { exact: true }).fill('09:30');
    await page.locator('.date-dialog .select-row select').nth(0).selectOption('weekly');
    await page.locator('.date-dialog').getByRole('button', { name: '确定', exact: true }).click();
    const s = await productState(); const task = s.tasks.find(t => t.title === '核对原版月视图'); planningTaskId = task.id;
    assert.equal(task.startDate, `${month}-15`); assert.equal(task.dueDate, `${month}-17`); assert.equal(task.time, '09:30'); assert.equal(task.repeat, 'weekly'); assert.equal(task.priority, 1); assert.deepEqual(task.tags, ['设计', '验收']); assert.equal(task.subtasks[0].completed, true); assert.match(task.content, /一致性/);
    await screenshot('desktop-detail-light');
  });
  await closeDetail();
  await step('月历渲染、筛选、月切换与任务拖动', async () => {
    await createTask('团队周会', `${month}-08`); await closeDetail();
    await createTask('整理读书笔记', `${month}-12`); await closeDetail();
    await createTask('周末采购', `${month}-24`); await closeDetail();
    await navigation('日历').click();
    await page.getByLabel('选择日历月份', { exact: true }).fill(month);
    await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '月', exact: true }).click();
    const title = page.locator('.cal-title-picker h1'); const before = await title.textContent();
    await page.getByRole('button', { name: '下一个日历周期', exact: true }).click(); assert.notEqual(await title.textContent(), before);
    await page.getByRole('button', { name: '上一个日历周期', exact: true }).click(); assert.equal(await title.textContent(), before);
    const filter = page.locator('.cal-list-filter').filter({ hasText: '产品计划' }); await filter.click(); assert.equal(await page.locator('.cal-event').filter({ hasText: '核对原版月视图' }).count(), 0); await filter.click();
    const event = page.locator('.cal-event').filter({ hasText: '核对原版月视图' }).first();
    const target = page.locator(`.cal-day[data-date="${month}-20"]`); const bounds = await target.boundingBox();
    await event.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 12 } });
    const s = await productState(); const moved = s.tasks.find(t => t.id === planningTaskId);
    assert.equal(moved.startDate, `${month}-20`, '拖入日是跨日任务的新开始日'); assert.equal(moved.dueDate, `${month}-22`, '跨日任务保留原3天跨度');
    await screenshot('desktop-calendar-light'); return await noHorizontalOverflow();
  });
  await step('月历双击新建与日周议程切换', async () => {
    const cell = page.locator(`.cal-day[data-date="${month}-26"]`); const bounds = await cell.boundingBox();
    await cell.dblclick({ position: { x: bounds.width / 2, y: bounds.height - 10 } });
    await page.getByRole('textbox', { name: '新任务标题', exact: true }).fill('月历直接添加');
    assert.equal(await page.getByLabel('新任务日期', { exact: true }).inputValue(), `${month}-26`);
    await page.locator('.new-task-dialog').getByRole('button', { name: '添加', exact: true }).click(); await closeDetail();
    for (const name of ['周', '日', '议程', '月']) { const button = page.getByRole('group', { name: '日历视图' }).getByRole('button', { name, exact: true }); await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true'); }
  });
  await step('搜索找到任务及描述', async () => {
    await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索全部任务', exact: true }).fill('一致性');
    await page.locator('.search-results').getByRole('button').filter({ hasText: '核对原版月视图' }).click();
    assert.equal(await page.getByRole('textbox', { name: '任务标题', exact: true }).inputValue(), '核对原版月视图'); await closeDetail();
  });
  await step('完成重复任务生成下一次且保留子任务', async () => {
    const event = page.locator('.cal-event').filter({ hasText: '核对原版月视图' }).first(); await event.click();
    const before = (await productState()).tasks.find(t => t.id === planningTaskId);
    await page.getByRole('button', { name: '完成任务', exact: true }).click();
    const s = await productState(); const series = s.tasks.filter(t => t.title === '核对原版月视图'); assert.equal(series.length, 2);
    assert.ok(series.find(t => t.id === planningTaskId).completedAt);
    const next = series.find(t => !t.completedAt); assert.equal(next.dueDate, addDays(before.dueDate, 7)); assert.equal(next.subtasks.length, 1); assert.equal(next.subtasks[0].completed, false);
    await closeDetail();
  });
  await step('任务删除与垃圾桶恢复', async () => {
    await navigation('任务').click();
    await page.locator('.app-sidebar').getByRole('button', { name: /^所有任务/ }).click();
    await page.locator('.task-row').filter({ hasText: '整理读书笔记' }).click();
    await page.getByRole('button', { name: '删除任务', exact: true }).click();
    await page.locator('.app-sidebar').getByRole('button', { name: /^垃圾桶/ }).click();
    await page.locator('.task-row').filter({ hasText: '整理读书笔记' }).click();
    await page.getByRole('button', { name: '恢复任务', exact: true }).click(); await closeDetail();
    await page.locator('.app-sidebar').getByRole('button', { name: /^所有任务/ }).click();
    await page.locator('.task-row').filter({ hasText: '整理读书笔记' }).waitFor();
  });
  await step('专注切换页面后继续并记录已用时间', async () => {
    await navigation('专注').click();
    const before = await page.locator('.timer-dial strong').textContent();
    await page.locator('.timer-start').click(); await navigation('任务').click();
    await page.waitForFunction(value => document.querySelector('.timer-dial strong')?.textContent !== value, before);
    await navigation('专注').click(); assert.notEqual(await page.locator('.timer-dial strong').textContent(), before);
    await page.locator('.timer-start').click(); await page.getByRole('button', { name: '重置计时', exact: true }).click();
    const s = await productState(); assert.ok(s.focusSessions.some(session => !session.completed && session.durationSeconds >= 1));
  });
  await step('新增习惯并记录当日打卡', async () => {
    await navigation('习惯').click(); await page.locator('.habit-view .view-header').getByRole('button', { name: '添加习惯', exact: true }).click();
    await page.getByLabel('习惯名称', { exact: true }).fill('每日读书');
    await page.locator('.habit-dialog').getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('button', { name: `每日读书 ${today} 打卡`, exact: true }).click();
    const s = await productState(); assert.equal(s.habits.find(h => h.name === '每日读书').records[today], 1);
    await navigation('任务').click();
  });
  await step('浅深主题与桌面生产布局', async () => {
    await theme('dark'); await screenshot('desktop-list-dark'); await navigation('日历').click(); await screenshot('desktop-calendar-dark');
    await theme('light'); await screenshot('desktop-calendar-light-final'); return await noHorizontalOverflow();
  });
  await step('手机390x844月历与设置可操作', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('mobile-calendar-light'); await noHorizontalOverflow();
    await theme('dark'); await screenshot('mobile-calendar-dark'); await theme('light');
    await navigation('任务').click(); await page.getByRole('button', { name: '展开清单', exact: true }).click();
    await page.locator('.app-sidebar').getByRole('button', { name: /^所有任务/ }).click(); await screenshot('mobile-list-light');
    await page.locator('.task-row').filter({ hasText: '周末采购' }).click(); await screenshot('mobile-detail-light'); await closeDetail();
    return await noHorizontalOverflow();
  });
  await step('备份导出与实际文件内容', async () => {
    await page.setViewportSize({ width: 1440, height: 960 }); await openSettings();
    await page.locator('.settings-nav').getByRole('button', { name: '数据与备份', exact: true }).click();
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: /导出备份/ }).click();
    const download = await downloadEvent; importedBackup = path.join(reportDir, 'ui-export-backup.json'); await download.saveAs(importedBackup);
    const value = JSON.parse(await fs.readFile(importedBackup, 'utf8')); assert.equal(value.format, 'dida-local-backup'); assert.ok(value.data.tasks.length >= 6); assert.ok(value.data.tasks.some(t => t.subtasks.length));
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); return { file: importedBackup, tasks: value.data.tasks.length };
  });
  await step('关闭重开浏览器保持任务和详情修改', async () => {
    const before = await productState(); await context.close();
    context = await chromium.launchPersistentContext(profile, launchOptions); page = await attach(context); await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('.app-shell').waitFor();
    const after = await productState(); assert.deepEqual(after, before); return { taskCount: after.tasks.length, listCount: after.lists.length, profile };
  });
  await step('新设备导入备份并避免重复导入', async () => {
    assert.ok(importedBackup, '需要前一步成功导出的备份');
    const oldContext = context; const oldPage = page;
    const importedContext = await chromium.launchPersistentContext(path.join(reportDir, 'import-profile'), launchOptions);
    try {
      page = await attach(importedContext); await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('.app-shell').waitFor();
      assert.equal((await productState()).tasks.length, 0);
      await page.locator('input[type="file"]').setInputFiles(importedBackup);
      await page.getByRole('status').filter({ hasText: /已导入/ }).waitFor();
      const imported = await productState(); const backup = JSON.parse(await fs.readFile(importedBackup, 'utf8')).data;
      assert.equal(imported.tasks.length, backup.tasks.length); assert.deepEqual(imported.tasks, backup.tasks);
      await page.locator('input[type="file"]').setInputFiles(importedBackup); await saved(); assert.equal((await productState()).tasks.length, backup.tasks.length);
      return { importedTasks: imported.tasks.length, duplicateImportPreservedCount: true };
    } finally { await importedContext.close(); context = oldContext; page = oldPage; }
  });
  await step('无页面异常与无外部网络依赖', async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); return { pageErrors: 0, externalRequests: 0 }; });
  }
  await context.close(); context = undefined;
  }
  if (withElectron) {
    await step('Electron隐藏磁盘、快速关闭、保存失败保护与坏文件恢复', async () => {
      const applicationRoot = packagedExecutable ? path.join(path.dirname(packagedExecutable), 'resources', 'app') : root;
      const mainSource = await fs.readFile(path.join(applicationRoot, 'electron', 'main.cjs'), 'utf8');
      assert.match(mainSource, /DIDA_LOCAL_HEADLESS/, '测试前必须存在专门的隐藏窗口入口');
      const dataDir = path.join(reportDir, 'electron-isolated-data');
      const environment = { ...process.env, DIDA_LOCAL_HEADLESS: '1', DIDA_LOCAL_DATA_DIR: dataDir };
      delete environment.ELECTRON_RUN_AS_NODE;
      const options = { executablePath: packagedExecutable || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: packagedExecutable ? [] : [root], env: environment, timeout: 60000 };
      report.electron = { executable: options.executablePath, args: options.args, dataDir, startsHidden: true };
      report.electron.runtimeSources = [];
      for (const name of ['electron/main.cjs', 'electron/preload.cjs']) {
        const bytes = await fs.readFile(path.join(applicationRoot, name));
        report.electron.runtimeSources.push({ file: path.join(applicationRoot, name), sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      let app;
      const launches = [];
      async function launch() {
        const value = await _electron.launch(options);
        await value.firstWindow();
        const status = await value.evaluate(({ app, BrowserWindow }) => ({ profile: app.getPath('userData'), appPath: app.getAppPath(), versions: { electron: process.versions.electron, chrome: process.versions.chrome }, windows: BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), url: w.webContents.getURL() })) }));
        assert.ok(status.profile.startsWith(dataDir), 'Electron必须使用隔离资料路径');
        assert.equal(status.windows.length, 1, '应只创建一个本地清单测试窗口');
        assert.ok(status.windows.every(w => !w.visible), '测试窗口不能显示到用户桌面');
        launches.push(status);
        return value;
      }
      try {
        app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
        await page.locator('.app-shell').waitFor();
        const initial = await page.evaluate(() => window.didaLocal.load()); assert.equal(initial.data?.tasks.length ?? 0, 0);
        await quickAdd('磁盘持久化验收任务'); await saved();
        await page.getByRole('textbox', { name: '任务描述', exact: true }).fill('关闭前最后一次修改，重新启动后必须完整保留。');
        const title = page.getByRole('textbox', { name: '任务标题', exact: true });
        await title.fill('关闭前修改标题');
        const closed = app.waitForEvent('close');
        await page.locator('.close-window').click().catch(error => { if (!/closed|Target page/.test(error.message)) throw error; });
        await closed; app = undefined;
        const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'database.json'), 'utf8'));
        assert.equal(disk.tasks.length, 1); assert.equal(disk.tasks[0].title, '关闭前修改标题'); assert.equal(disk.tasks[0].content, '关闭前最后一次修改，重新启动后必须完整保留。');
        app = await launch(); page = await app.firstWindow(); await page.locator('.app-shell').waitFor();
        const reloaded = await page.evaluate(() => window.didaLocal.load()); assert.deepEqual(reloaded.data, disk);
        await page.locator('.task-row').filter({ hasText: '关闭前修改标题' }).click();
        assert.equal(await page.getByRole('textbox', { name: '任务描述', exact: true }).inputValue(), disk.tasks[0].content);
        // Cause a real rename failure only inside the dedicated test data directory.
        // Native message boxes are replaced in this test process so no desktop UI appears.
        await app.evaluate(({ dialog }) => {
          globalThis.__didaSmokeDialogs = [];
          dialog.showMessageBox = async (_window, options) => { globalThis.__didaSmokeDialogs.push(options); return { response: 0 }; };
        });
        const dataFile = path.join(dataDir, 'database.json');
        const preservedFile = path.join(dataDir, 'before-write-fault.json');
        await saved(); await fs.rename(dataFile, preservedFile); await fs.mkdir(dataFile);
        await page.getByRole('textbox', { name: '任务描述', exact: true }).fill('故障期间的修改必须留在窗口');
        await page.locator('.save-indicator.error').waitFor({ state: 'attached' });
        await page.evaluate(() => window.didaLocal.windowAction('close'));
        const failureProtection = await app.evaluate(async ({ BrowserWindow }) => {
          for (let attempt = 0; attempt < 40 && !globalThis.__didaSmokeDialogs.length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
          const windows = BrowserWindow.getAllWindows();
          return { dialogCount: globalThis.__didaSmokeDialogs.length, buttons: globalThis.__didaSmokeDialogs[0]?.buttons, windows: windows.map(w => ({ destroyed: w.isDestroyed(), visible: w.isVisible() })) };
        });
        assert.equal(failureProtection.dialogCount, 1); assert.equal(failureProtection.buttons[0], '返回应用');
        assert.equal(failureProtection.windows.length, 1); assert.equal(failureProtection.windows[0].destroyed, false); assert.equal(failureProtection.windows[0].visible, false);
        assert.equal(await page.getByRole('textbox', { name: '任务描述', exact: true }).inputValue(), '故障期间的修改必须留在窗口');
        assert.ok((await fs.stat(dataFile)).isDirectory(), '只移除本测试创建的空故障目录');
        await fs.rmdir(dataFile); await fs.rename(preservedFile, dataFile);
        await page.getByRole('textbox', { name: '任务描述', exact: true }).fill('故障解除后保存成功'); await saved();
        let closedAgain = app.waitForEvent('close'); await page.locator('.close-window').click().catch(error => { if (!/closed|Target page/.test(error.message)) throw error; }); await closedAgain; app = undefined;
        const repaired = JSON.parse(await fs.readFile(dataFile, 'utf8')); assert.equal(repaired.tasks[0].content, '故障解除后保存成功');
        const backupBeforeRecovery = JSON.parse(await fs.readFile(path.join(dataDir, 'database.backup.json'), 'utf8'));
        const corruptBytes = '{invalid-json-for-isolated-recovery-test'; await fs.writeFile(dataFile, corruptBytes, 'utf8');
        app = await launch(); page = await app.firstWindow(); await page.locator('.app-shell').waitFor(); await saved();
        const recovered = await page.evaluate(() => window.didaLocal.load()); assert.deepEqual(recovered.data, backupBeforeRecovery);
        const corruptFiles = (await fs.readdir(dataDir)).filter(name => name.startsWith('database.corrupt-') && name.endsWith('.json'));
        assert.ok(corruptFiles.length >= 1);
        assert.ok((await Promise.all(corruptFiles.map(name => fs.readFile(path.join(dataDir, name), 'utf8')))).includes(corruptBytes));
        report.electron.launches = launches;
        report.electron.saveFailureProtection = { ...failureProtection, dialogWasStubbedToReturn: 0, realFileRenameFailed: true };
        report.electron.corruptRecovery = { originalBytesPreserved: true, files: corruptFiles, taskCount: recovered.data.tasks.length };
        report.electron.visualEvidence = 'Production UI screenshots are recorded by headless Chrome. The native window stays hidden; no compositor screenshot is requested.';
        assert.deepEqual(report.pageErrors, []);
        return { dataFile, taskCount: disk.tasks.length, lastEditRetained: true, saveFailureKeptWindow: true, corruptOriginalPreserved: true, visibleWindows: 0 };
      } finally {
        if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {}); await app.close(); }
      }
    });
  }
} catch (error) { fatal = error; report.fatal = error.stack || String(error); console.error(error); }
finally {
  await context?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.filter(test => test.status === 'passed').length;
  report.failed = report.cases.filter(test => test.status === 'failed').length;
  await updateReport();
  console.log(JSON.stringify({ report: path.join(reportDir, 'result.json'), passed: report.passed, failed: report.failed, fatal: !!fatal }));
  if (report.failed || fatal) process.exitCode = 1;
}
