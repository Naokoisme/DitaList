# DitaList Rust Preview

Windows 本地任务与日历客户端。复用 DitaList 的 React 界面，使用 Rust 核心、原生悬浮栏和按需创建的 Tauri WebView2 窗口。

此工程位于 `D:\ditalist-rust`，是独立预览项目。原版来源及后续增量见 [源码来源](docs/source-provenance.md)。默认数据为 `%APPDATA%\DitaListRustPreview\data`；不会自动读取日用版数据。可从设置显式导入 JSON／CSV 备份，旧文件保持原样。

## 运行和构建

需要 Node.js 22、固定 Rust 1.99.1、Windows x64 MSVC Build Tools、Windows SDK 和 WebView2。工具链由 `rust-toolchain.toml` 固定，依赖由 Cargo.lock／package-lock.json 固定。

```powershell
cd D:\ditalist-rust
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH
npm ci
npm run contracts
npm run desktop:dev
```

开发验证应先设置独立目录：`$env:DITALIST_DATA_DIR = 'D:\ditalist-rust\.local\dev-profile'`。正式开发主程序也使用预览应用身份；同一预览身份一次只运行一份。

```powershell
cargo test --locked -p ditalist-core -p ditalist-mcp
npm test
npm run desktop:build
cargo build --locked --release -p ditalist-mcp
```

主程序位于 `target\release\DitaListRust.exe`；`--main` 可直接打开主界面。正常启动只创建原生栏和托盘。`Ctrl+Alt+Space` 展开快速输入。主界面关闭后保留 30 秒再释放，托盘“退出”才结束后台。

独立 Git 提交完成后，运行 `node scripts/package-preview.mjs` 生成免安装 ZIP、Inno Setup 和产物哈希清单。脚本要求干净工作区，并重新构建主程序与 MCP。默认不签署候选，不推送或创建 Release。

诊断构建可显式设置 `VITE_DITALIST_DRAG_TRACE=1` 记录拖放事件名/坐标/MIME类型（不记录任务正文）；`DITALIST_SOURCE_MAPS=1` 输出源码映射。候选打包关闭这两项。`runtime.jsonl` 记录窗口请求/就绪/销毁、命令结果和退出，联系凭据不进入日志。

## 模块与状态

| 目录 | 职责 |
| --- | --- |
| crates/contracts | Rust 共享类型；生成 TypeScript 与命令 Schema |
| crates/core | 唯一业务状态、JSON 保存、审核、回收站、提醒、专注、导入 |
| crates/mcp | 官方 rmcp stdio 桥接、本机动态地址发现、实例校验与收尾 |
| src-tauri/src/desktop | Win32 原生栏／提醒、窗口、托盘、快捷键 |
| src | 复用产品页面、真实 IPC 适配器和整条快速输入 |

所有写操作进入核心命令，界面不能覆盖整库。主库 `database.rust.json` 的版本为 2，同时包含业务数据、修订号、审核申请、请求回执和提醒状态；兼容备份保留旧业务包装。保存失败不发布新状态，上一有效备份和损坏原件予以保留。

MCP 默认关闭，用户在设置开启后复制标准 stdio 配置。见 [MCP 接入](docs/mcp.md)。业务请求号在首次操作时生成，重试保持原号；创建和修改均需本地审核，删除只入回收站。

架构约定见 [架构草案](docs/architecture.md) 和 [接口合同](docs/interfaces.md)。实际验收范围与限制见 [验证报告](docs/validation.md)，不得以编译或浏览器 fixture 通过代替真实桌面验收。

2026-10-30 安装后调整：主任务页面统一使用「＋」新增，Agent 待确认改为独立审核页，导航长按原位排序／隐藏，左下角固定齿轮设置；悬浮栏增加拖柄手势区分与贴边吸附。交互、验证与后续候选见 [安装反馈记录](docs/feedback-20261030.md)。

贴边交互已按试用反馈修正为自动收成白色细线：鼠标移入展开，移出约半秒收回，拖离边缘恢复完整圆角悬浮栏；收展有短暂原生动画。输入和提醒操作期间不自动收起；静止状态无动画计时，不创建 WebView。主窗口恢复时清除窗口控制按钮的旧悬停高亮，保留正常键盘与表单焦点。

首轮候选位于 `release/20261030-052508-225c8fa2e0ec/`，曾验证独立目录安装、覆盖与数据保留；当次测试安装已经正常卸载，候选与隔离验收数据保留。后续候选分别位于 `release/<UTC时间>-<源码提交>/`，以目录内 `artifacts.json` 核对来源提交和 SHA-256。本次反馈修正的手动交互与覆盖安装由用户继续验收，未用首轮结果代替新包验收。
