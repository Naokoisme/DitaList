import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, completeTask, createEmptyData, createTask, importBackupText, nextRecurringDate, parseCsv, parseQuickInput, validateData } from '../src/core/domain.ts';

test('空数据独立于原版，带有收集箱且不注入示例任务', () => {
  const data = validateData(createEmptyData());
  assert.equal(data.tasks.length, 0);
  assert.equal(data.lists[0].id, 'inbox');
});

test('拒绝无效日期、孤立任务与重复 ID', () => {
  const data = createEmptyData();
  const task = createTask({ title: '原任务', dueDate: '2026-02-28' });
  assert.throws(() => validateData({ ...data, tasks: [{ ...task, dueDate: '2026-02-31' }] }), /日期/);
  assert.throws(() => validateData({ ...data, tasks: [{ ...task, listId: 'not-there' }] }), /不存在的清单/);
  assert.throws(() => validateData({ ...data, tasks: [task, task] }), /重复/);
});

test('每月重复保持原始31号锚点，保留历史并重置子任务', () => {
  let data = createEmptyData();
  data.tasks = [createTask({ title: '月末复盘', dueDate: '2026-01-31', repeat: 'monthly', subtasks: [{ id: 's1', title: '记录', completed: true }] })];
  data = completeTask(data, data.tasks[0].id, new Date('2026-01-31T09:00:00+08:00'));
  let active = data.tasks.find(task => !task.completedAt)!;
  assert.equal(active.dueDate, '2026-02-28');
  assert.equal(active.recurrenceAnchor, '2026-01-31');
  assert.equal(active.subtasks[0].completed, false);
  assert.notEqual(active.subtasks[0].id, 's1');
  data = completeTask(data, active.id, new Date('2026-02-28T09:00:00+08:00'));
  active = data.tasks.find(task => !task.completedAt)!;
  assert.equal(active.dueDate, '2026-03-31');
  assert.equal(data.tasks.filter(task => task.completedAt).length, 2);
  assert.equal(validateData(data).tasks.length, 3);
});

test('闰年年重复和周五工作日重复符合日历', () => {
  assert.equal(nextRecurringDate('2024-02-29', 'yearly'), '2025-02-28');
  assert.equal(nextRecurringDate('2027-02-28', 'yearly', '2024-02-29'), '2028-02-29');
  assert.equal(nextRecurringDate('2026-10-30', 'weekdays'), '2026-11-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('重复完成调用不会生成第二份后续任务', () => {
  const data = createEmptyData();
  const task = createTask({ title: '每天阅读', dueDate: '2026-10-28', repeat: 'daily' });
  data.tasks = [task];
  const once = completeTask(data, task.id);
  const twice = completeTask(once, task.id);
  assert.equal(twice.tasks.length, 2);
  assert.equal(data.tasks[0].completedAt, null);
});

test('快速输入识别中文日期、时间、标签和优先级', () => {
  const result = parseQuickInput('明天下午3点半 整理资料 #工作 !1', 'inbox', '2026-10-28');
  assert.equal(result.title, '整理资料');
  assert.equal(result.dueDate, '2026-10-29');
  assert.equal(result.time, '15:30');
  assert.equal(result.priority, 1);
  assert.deepEqual(result.tags, ['工作']);
  assert.equal(parseQuickInput('大后天 买菜', 'inbox', '2026-10-28').dueDate, '2026-10-31');
  assert.equal(parseQuickInput('2026-12-01 09:20 会议', 'inbox', '2026-10-28').title, '会议');
});

test('CSV 解析支持引号、逗号和字段内换行，拒绝破损引号', () => {
  assert.deepEqual(parseCsv('Title,Content\r\n"A, B","first\nsecond ""quoted"""\r\n'), [['Title', 'Content'], ['A, B', 'first\nsecond "quoted"']]);
  assert.throws(() => parseCsv('Title\n"unterminated'), /未闭合/);
});

test('滴答 CSV 导入合并已有任务，重复导入幂等，不执行内容', () => {
  const current = createEmptyData();
  current.tasks = [createTask({ title: '已有内容' })];
  const csv = 'Date: 2026-10-28\nList Name,Title,Content,Due Date,Priority,Status,Repeat\n工作,"整理,资料","第一行\n<script>alert(1)</script>",2026-10-29,5,0,\n生活,已完成,说明,2026-10-27,1,2,FREQ=DAILY\n';
  const result = importBackupText(csv, current);
  assert.equal(result.count, 2);
  assert.equal(result.data.tasks.length, 3);
  const imported = result.data.tasks.find(task => task.title === '整理,资料')!;
  assert.equal(imported.priority, 1);
  assert.equal(imported.dueDate, '2026-10-29');
  assert.equal(imported.content, '第一行\n<script>alert(1)</script>');
  assert.equal(result.data.tasks.find(task => task.title === '已完成')!.repeat, 'daily');
  assert.equal(importBackupText(csv, result.data).count, 0);
  assert.equal(current.tasks.length, 1);
});

test('JSON 备份合并并保留本机已有内容及设置', () => {
  const current = createEmptyData();
  current.settings.theme = 'dark';
  current.tasks = [createTask({ id: 'known', title: '本机修改' })];
  const incoming = createEmptyData();
  incoming.tasks = [createTask({ id: 'known', title: '旧备份' }), createTask({ title: '新任务' })];
  const result = importBackupText(JSON.stringify({ data: incoming }), current);
  assert.equal(result.count, 1);
  assert.equal(result.data.tasks.find(task => task.id === 'known')!.title, '本机修改');
  assert.equal(result.data.settings.theme, 'dark');
  assert.throws(() => importBackupText('{bad json', current), /无法解析/);
  assert.equal(current.tasks.length, 1);
});

test('CSV 仅有开始日期时仍排入日历，复杂重复不被错误简化', () => {
  const csv = 'List Name,Title,Start Date,Due Date,Repeat\n日程,每两周开会,2026-10-29,,FREQ=WEEKLY;INTERVAL=2\n';
  const result = importBackupText(csv, createEmptyData());
  assert.equal(result.data.tasks[0].dueDate, '2026-10-29');
  assert.equal(result.data.tasks[0].repeat, 'none');
  assert.match(result.data.tasks[0].content, /FREQ=WEEKLY;INTERVAL=2/);
  assert.equal(result.warnings.length, 1);
});
