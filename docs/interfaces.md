# 实施合同 v1

来源：DitaList `1d51ac981db7ea1db0266a58ea72908dba698b7e`。开发根目录 `D:\ditalist-rust`；默认数据 `%APPDATA%\DitaListRustPreview\data`，可用 `DITALIST_DATA_DIR` 指定隔离目录。禁止自动读日用数据。

## 核心

公共类型见 `crates/contracts`。`ditalist_core::CoreService` 可 Clone（内部共享串行状态），接口：
- `open(data_dir: impl AsRef<Path>) -> Result<Self, CoreError>`。
- `snapshot(&self) -> CoreSnapshot`。
- `execute(&self, command: CoreCommand, caller: Caller) -> Result<CommandReceipt, CoreError>`。
- `get_request(&self, request_id: &str) -> Option<CommandReceipt>`。
- `tick(&self) -> Result<Vec<CoreEffect>, CoreError>`：处理到期提醒/专注，只有状态变化才持久化。
- `next_wake_ms(&self) -> Option<u64>`：下次必要唤醒的等待毫秒，无任务则 None；专注按真实截止时间唤醒。快照提供 `focus.deadline`，可见页面按截止时间重绘倒计时，隐藏时停止重绘；完成和历史写入仍由核心负责。
- `export_backup(&self) -> Result<String, CoreError>`：兼容 JSON 导出。

创建/更新 input 与 patch 先作为 JSON 边界验证，字段语义沿用基线；禁止全 AppData 替换。CollectionUpsert 仅允许 lists/folders/habits/filters 的单实体。实体 ID 可由本地表单产生；核心验证唯一性与关联。MCP 不允许 collection/settings/preferences/永久删除/批准操作。

核心正式状态只在落盘成功后替换；requestId 同号同参返回原回执，同号异参冲突，回执与业务同快照。提醒/专注必须脱离 Web；UI 可显示本地倒计时但不推进权威状态。所有调用来源由宿主固定，不从 IPC payload 读取。

## Web IPC

使用 `@tauri-apps/api/core` 的 invoke 和 event.listen。命令（参数为 camelCase）：
- `core_snapshot()` -> CoreSnapshot；`core_execute({command})` -> CommandReceipt；`core_get_request({requestId})` -> receipt|null。
- 监听 `core://changed` 获取 CoreSnapshot（先订阅再取快照，以 revision 拒绝旧消息）。
- `draft_get()`/`draft_set({draft})`；草稿只在宿主进程内。
- `desktop_action({action, payload?})`：openMain（payload.view）、openQuick、closeQuick、minimize、maximize、closeMain、showReminders、quit、revealData、createShortcut、removeShortcut。
- `mcp_info()` -> McpInfo；开启/关闭经 PreferencesUpdate，通道状态监听 `mcp://state`。
- `backup_export()` -> bool（保存对话框）；`backup_import()` -> string|null（读取 JSON/CSV）。导入后用 Import 命令处理。
- 主界面监听 `desktop://navigate` 的 `{view, taskId?}`；审核 view 为 agent-review。
- `desktop_status()` -> `{ floatingVisible, shortcutExists, dataPath, backupPath }`。
- 显式退出先发 `desktop://prepare-exit` `{window}`，Web 交接并回复 `desktop_action("exitReady",{window,ready})`，确认前不销毁窗口。拒绝／超时会取消退出并发 `desktop://exit-cancelled` 恢复输入；宿主随后关闭受理门禁、等待在途写和 MCP 收尾。
- Web 挂载后 `desktop_action({action:"ready",payload:{window:"main"|"quick"}})` 才显示；输入 resize 使用 action=`quickResize`、payload=`{width,height}`。监听 `desktop://prepare-close` 的 `{window}`，先交接草稿/编辑内容后调用 closeMain/closeQuick。ListMove 操作按共享枚举一次完成排序。

提交 requestId 由首次提交生成，失败/不明结果保留原号；禁止在旧自动保存 effect 中调用 core_execute。原生输入与 Web 整条输入切换，不共用同时显示的区域。

## 桌面模块

`desktop::Desktop` 用 `start(app: tauri::AppHandle, actions: std::sync::mpsc::Sender<DesktopAction>) -> Result<Self,String>` 初始化，提供 `update(&self, snapshot: CoreSnapshot)`, `action(&self, action:&str, payload:serde_json::Value)->Result<(),String>`, `shutdown(&self)`。可用 Arc 包装管理。DesktopAction 枚举由桌面模块定义并向 root 通报，至少包含业务 Command(Operation)、Navigate(view)、Quit、ReminderPresented(ids)。提醒面板显示成功后由核心 Reminder action="notified" 记录。原生线程不直接操作核心存储。

窗口无预建 WebView。原生栏 default40x180 DIP，输入420至560 DIP；主窗口按原风格。核心快照推进原生计数，安静/输入/用户隐藏按草案分流。Tauri 最后窗口释放不退出；显式退出才结束后台。

## 导航增量与失败终态

`Settings.navigation` 缺省为空排序／隐藏；`NavigationUpdate` 一次提交 preferences 和 renames。标签互换、过滤器完整词、任务标签和导航键由核心原子改写。新建主窗使用 defaultView；已存活主窗没有显式导航时保持原视图。

MCP 已受理但保存失败的操作保留原参数。关闭时重试，仍为存储错误则显示 closing_failed；若操作已因用户本地改动变成版本冲突等业务终态，核心 `settle_rejected` 持久化 `status=rejected` 和 result.error 后完成关闭，原请求仍可查询，不会无限重试。

## 分工

root：合同与生成、根清单/锁、src-tauri 启动与 IPC、MCP、脚本/文档与集成。core：crates/core/src 与测试。desktop：src-tauri/src/desktop。web：src（排除 generated）及 tests/web-*。先依合同实现；需要新增操作或窗口 IPC 先发消息给 root。
