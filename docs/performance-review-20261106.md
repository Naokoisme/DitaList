# DitaList 与 Mail-Naoko 性能审查

本轮使用合成数据、隔离测试目录和本地假 IMAP；未访问日用数据库、未发送真实邮件、未安装或发布。可用子代理模型为 GPT-6 Astra，所请求的 Flash 模型未在路由中提供。

## 已实施

- DitaList CalendarView：周日期数组从每事件构造改为每周构造；重叠事件结束位置改为增量最大值。
- DitaList 桌面宿主：复用 publish 已生成快照中的 MCP 开关，省去每次本地命令后的第二份完整快照。
- Mail-Naoko storage：增加 message_account_key_id、attachment_message_id 表达式局部索引，保持查询和去重语义。首次打开旧库会创建索引，存在额外存储和维护成本；本轮没有测量大型真实库建索引时间。
- Mail-Naoko service：失败后的待处理文件夹不再覆盖同步退避截止时间；成功后的残留工作仍立即调度。保留原有用户未提交修改。

## 实测

日历采用固定优化前提交 1d562fc819f1486e0ebedb245b2813a864a520e4，从源码提取实际纯函数，5次预热、30次交替采样取中位数，验证完整布局输出一致。

| 场景 | 前 ms | 后 ms |
|---|---:|---:|
| 周布局 3000事件 | 17.931 | 4.776 |
| 时间布局 2000密集重叠事件 | 20.985 | 3.555 |
| 时间布局 2000分组事件 | 1.759 | 0.849 |

邮件采用项目 rusqlite 内存库、debug构建、1次预热和5次采样中位数，固定两账号和跨文件夹副本。计时包括SQL准备、结果物化与一致性断言。

| 场景 | 前 ms | 后 ms |
|---|---:|---:|
| 600封邮件分类计数+首页 | 186.262 | 1.768 |
| 1800封邮件分类计数+首页 | 2914.273 | 14.514 |
| 3000附件中读取目标3条 | 1.687 | 0.018 |
| 9000附件中读取目标3条 | 11.008 | 0.038 |

EXPLAIN确认分类子查询使用 account_id + expression + id 范围搜索，附件使用 expression 搜索。基准结果前后一致。数值只说明合成负载下局部函数/SQL收益，不代表桌面端到端响应、CPU或内存改善；不是release实测。

## 验证命令与结果

- DitaList `cargo test --locked -p ditalist-core`：53通过。
- `node --import tsx --test tests/calendar-layout-performance.test.ts`：5通过。
- `npm run build` 与 `cargo check --locked -p ditalist-desktop`：通过。
- 首次 `npm test`：91通过、2项浏览器首次启动超时；`node --import tsx --test --test-concurrency=1 tests/floating-grip.test.ts tests/web-ui.test.ts` 全通过。并行测试稳定性仍待调查，没有宣称已修复原因。测试重写的已有截图已恢复。
- Mail-Naoko 设置 `MAIL_NAOKO_DATA_DIR=D:/Mail-Naoko/.local/perf-review-isolated` 后运行 `./scripts/cargo.ps1 test --locked -p mail-naoko-core`：46通过，1项真实Gmail探测忽略。包括新旧库升级与重复打开、同步失败保留退避/队列及成功残留工作调度。
- `./scripts/cargo.ps1 run --offline --locked -p mail-naoko-core --example query_index_benchmark`：通过，20.198秒。
- 两项目 `git diff --check`：通过。

旧库迁移测试在显式隔离目录保留带随机ID的合成SQLite作为证据。日历基准依赖上述Git历史提交。

## 后续重点

1. DitaList 专注到期落盘持续失败时，next_wake返回0、宿主最小10ms重试，需加入故障退避及恢复验收。本轮仅静态确认，未修改。
2. DitaList 重复revision快照仍可能全量解析/渲染，去重前需厘清同revision时间派生状态。
3. Mail-Naoko 全局刷新触发多资源请求，可能把已加载分页重置为首页；应独立验证刷新合并与分页保持。
4. 补充桌面实际启动、交互延迟、空闲CPU/内存和大库索引建立成本测量。
