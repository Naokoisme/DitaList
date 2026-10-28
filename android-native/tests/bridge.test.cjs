const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const requests = [];
  const window = { DidaNative: { invoke: (id, method, payload) => requests.push({ id, method, payload }) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8'), { window, Map, Promise, Error, Object, JSON });
  return { window, requests };
}

test('原生导出仅在实际文件写入回调后返回成功', async () => {
  const { window, requests } = setup();
  let finished = false;
  const promise = window.didaLocal.exportBackup({ schemaVersion: 1 }).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(requests[0].method, 'export');
  assert.equal(requests[0].payload, '{"schemaVersion":1}');
  window.__didaNativeReply(requests[0].id, true, 'true');
  assert.equal(await promise, true);
});

test('取消文件选择和原生读写失败不会报成功', async () => {
  const { window, requests } = setup();
  const cancelled = window.didaLocal.exportBackup({});
  window.__didaNativeReply(requests[0].id, true, 'false');
  assert.equal(await cancelled, false);
  const imported = window.didaLocal.importBackup();
  window.__didaNativeReply(requests[1].id, true, 'null');
  assert.equal(await imported, null);
  const failed = window.didaLocal.save({});
  window.__didaNativeReply(requests[2].id, false, '"存储空间不足"');
  await assert.rejects(failed, /存储空间不足/);
});

test('原生 JSON 文本按数据返回，不执行备份内容', async () => {
  const { window, requests } = setup();
  const imported = window.didaLocal.importBackup();
  const content = '</script><script>throw new Error("not data")</script>';
  window.__didaNativeReply(requests[0].id, true, JSON.stringify(content));
  assert.equal(await imported, content);
  assert.equal(Object.isFrozen(window.didaLocal), true);
});
