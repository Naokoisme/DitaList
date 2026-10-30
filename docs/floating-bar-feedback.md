# 悬浮栏第 4 点反馈修正

日期：2026-10-30（Asia/Shanghai）。实施基线：`a78358d1d09cf31b2b4d4c05f9bf6021d23dbe67`。

本专项只处理拖柄误操作、提示和屏幕工作区吸附。版本保持 `0.0.0`；专项会话交付时未自行提交、推送、发包或替换日用安装，交由主会话统一集成；`D:\dida-local` 未修改。主会话的导航改动不归入本报告，合并后的验证见 [安装反馈调整](feedback-20261030.md)。

## 原因与修正

原生 `window_proc` 原来把每个 `WM_COMMAND` 的低 16 位都当作业务按钮点击，丢掉了通知类型和来源窗口。按钮焦点、按下状态等通知因此也可能进入 `ADD → OpenQuick`。微软定义的按钮点击必须同时包含 `BN_CLICKED` 和发出通知的控件句柄。本轮只允许通知码、控件 ID、句柄三者匹配的点击进入业务处理；拖柄 ID 始终没有打开输入的业务动作。[WM_COMMAND](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-command)、[BN_CLICKED](https://learn.microsoft.com/en-us/windows/win32/controls/bn-clicked)。

这是源码确认的消息处理缺陷。尚未捕获用户当次点击的原生消息序列，不能把这条分析称为该现场的完整复现。

展开态另有一个确定的问题：拖柄的 `pointerdown` 直接保存草稿并调用 `quickDrag`，单击也会销毁输入窗口。现在单击和小幅抖动保留编辑；移动达到 4 个 CSS 像素才交接草稿并请求拖动。输入法组合、在途提交、退出交接期间不开始拖动；草稿保存失败时保留输入与错误。宿主再次检查左键仍处于按下状态，避免草稿保存稍慢时把已经结束的手势变成收起操作。

原生拖柄使用系统 `DragDetect` 区分单击和拖动。Web 输入交接给原生栏后，改为投递系统移动消息，先释放 `Runtime` 的 `RefCell` 可变借用，再进入 Windows 移动消息循环。旧实现同步发送消息时，重入的移动开始、结束和 DPI 消息可能因借用失败而跳过更新。[DragDetect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-dragdetect)。

删除“方向键微调”提示及其旧位移分支，方向键恢复标准原生按钮导航。拖柄提示为“拖动悬浮栏，靠近屏幕边缘自动吸附”。保留现有短栏、输入栏样式和草稿的进程内生命周期。

## 吸附行为

以下是 `de3d620` 首次反馈候选的停靠实现；用户试用后要求收成细线，后文“贴边细线修正”替代这里的留白停靠行为。

- 松手时，距当前显示器工作区边缘不超过 16 DIP 即吸附，留下 8 DIP 边距；角落可以同时吸附两个方向。DIP 随当前窗口 DPI 换算成物理像素。
- 拖离边缘即可解除吸附。计数导致栏宽变化、DPI 和工作区变化时，已经吸附的边保持稳定；拖动中的计数更新不重新布局按钮。
- 使用当前显示器的 `rcWork`，支持负坐标显示器，并按工作区限制位置；工作区已经扣除了任务栏。输入窗口伸展也补齐上、左、右、下的工作区限制。[GetMonitorInfoW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmonitorinfow)。
- 吸附由原生拖动结束和已有布局事件触发，没有常驻动画、额外轮询或收起态 WebView。

## 修改归属

| 文件 | 内容 |
| --- | --- |
| `src/FloatingApp.tsx` | 输入态手势阈值、焦点与草稿交接保护 |
| `src/floating.css` | 拖动时的光标反馈 |
| `src-tauri/src/desktop/native.rs` | 按钮消息来源校验、原生拖动、吸附触发与提示 |
| `src-tauri/src/desktop/mod.rs` | 原生／Web 拖动交接和工作区边界 |
| `src-tauri/src/desktop/position.rs` | 物理坐标与 DPI 吸附计算，6 项针对性回归 |
| `tests/floating-grip.test.ts` | 实际生产 React 输入组件的手势／保存失败检查；仅 IPC 使用隔离 fixture |
| 本文 | 根因、交付与证据边界 |

## 验证

全部命令在 `D:\ditalist-rust` 执行。Rust 命令使用 README 中的 Cargo PATH 设置。

| 命令／检查 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `cargo test --locked -p ditalist-desktop desktop::` | 9 项通过：新增消息合同 1 项、吸附坐标 6 项，以及既有提醒 2 项；属于源码回归 |
| `node --import tsx --test tests/floating-grip.test.ts` | 2 项通过：浅色 440px、深色 320px；检查单击、键盘、抖动、拖动、草稿与保存失败；属于生产前端组件回归 |
| `cargo clippy --locked -p ditalist-desktop --bin DitaListRust -- -D warnings` | 通过 |
| `node node_modules/vite/bin/vite.js build --outDir .local/floating-feedback/fixed-dist` | 生产前端构建通过，未写共享 `dist` |
| `cargo build --locked --release -p ditalist-desktop --bin DitaListRust --features tauri/custom-protocol` | 通过；候选哈希及最终运行结果见下方证据 |

测试候选仅通过构建期 `TAURI_CONFIG` 覆盖应用标识为 `Naoko.DitaList.RustPreview.FloatingFeedback`，并引用上述独立前端目录；仓库配置、宿主装配、依赖和锁文件未修改。隔离标识是必要条件：预览版单实例锁以应用标识为键，单独更换 `DITALIST_DATA_DIR` 仍会把第二次启动转给正在日用的实例。独立数据路径在 `.local/floating-feedback/` 内。

基线生产 Tauri 的主界面曾通过 Computer Use 实际观察，运行日志记录了 `ready(main)`。直接 Cargo 构建但未启用 `tauri/custom-protocol` 的首次尝试使用了开发地址，加载失败，已停止；后续生产构建显式启用该 feature。该失败没有被当作产品缺陷或通过证据。

最终候选为 `.local/floating-feedback/fixed/DitaListRust.exe`，SHA-256：`fc374a89ab5efb4980a5ba8398024f2a9d26d8813e762165107eee3403eba87c`。14:27:55 以隔离数据正常启动、不打开主界面；14:28:31 和 14:28:32 两次实际进程树均只有候选宿主进程，WebView2 子进程为 0。这证明本次收起态冷启动没有创建 WebView，不代表已经验证快速输入关闭后的释放路径。并行实例出现的快捷键占用日志来自日用实例已经注册 `Ctrl+Alt+Space`，没有更改或抢占日用快捷键。

候选随后通过自身的 `--quit` 正常退出。日用安装进程 PID 46552 持续存在，程序路径仍为 `D:\DitaList Rust Preview\DitaListRust.exe`。基线和最终测试实例均已结束；最终候选二进制及日志保留供主会话审查。

本次 Computer Use 的 `sky.list_windows()` 与 `sky.list_apps()` 没有枚举原生工具栏／快速输入窗口。未使用模拟窗口替代原生栏，也未通过其他输入注入绕过窗口选择。原生单击、实际拖动吸附、混合 DPI 和多屏拔插仍缺少交互验收；上面的坐标测试不能代替这些验收。主会话开始桌面 UI 检查后，本会话停止了 UI 输入，避免抢占窗口。

证据位于 `reports/floating-feedback-20261030/`：`native-tests.log`、`floating-grip-tests.log`、`desktop-clippy.log`、`frontend-build.log`、`release-build.log`、`fixed-binary.json`、`source-hashes.json`、`fixed-run.json`、`native-only-processes.json`、`fixed-exit.json`、`fixed-runtime.jsonl`，以及基线运行日志和前端浅／深色截图。上述专项候选只供本地集成验证，不是安装包或已发布版本；专项交付时的共享 `target/release/DitaListRust.exe` 使用临时验证标识，总集成须以正常标识重新构建。

## 贴边细线修正

用户对 `de3d620` 候选的补充反馈：“我想的是吸附到屏幕边缘变成一条细线”。这次交互为：

- 靠近当前显示器工作区边缘 16 DIP 内松手，收成 4 DIP 主题色细线。上下为最长 64 DIP 的横线，左右为随栏高的竖线；角落只显示一条线，任务栏区域排除在外。
- 鼠标移入细线，原地展开完整原生栏；移出约 500ms 后收回。完整栏紧贴工作区边界，不留下鼠标必须跨越的缝隙。
- 按住拖柄拖离边缘后恢复自由悬浮。栏内按钮之间移动、按住按钮／拖柄、操作提醒、快速输入及拖动期间不收起；右键菜单期间暂停计时。
- 提醒仍遵循已有规则临时展开，结束后收回。细线只是悬浮栏显示状态，不改写用户的显示开关或通知偏好。

完整矩形独立缓存，避免隐藏后的窄矩形污染快捷输入锚点；顶部／底部细线在计数增长时保留中心。Web 拖动交接主动同步移动后的完整矩形，避免重入消息被延后时又回到旧位置。所有栏按钮跟踪鼠标离开，延迟到期重新核对当前位置和捕获；取消、过期和重新计时消息通过截止时间区分。

实现使用 [TrackMouseEvent／WM_MOUSELEAVE](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mouseleave) 和 [SetTimer／KillTimer](https://learn.microsoft.com/en-us/windows/win32/winmsg/using-timers)。只有一次待执行的 500ms 检查，触发后取消；静止细线不需要轮询、动画、额外线程或 WebView。`runtime.jsonl` 的 `native_bar` 事件记录 `floating`／`expanded`／`edge` 状态及实际窗口矩形，便于核对实际使用路径。

针对性检查：`cargo test --locked -p ditalist-desktop desktop::` 13 项通过，覆盖四边细线、DPI、负坐标显示器、角落、计数增长、极小工作区、原生按钮消息与既有提醒。严格 Clippy 通过。只读复核已核对鼠标捕获、窗口借用重入、定时消息乱序及输入交接；这些检查不替代实际鼠标交互。日志保留在 `reports/edge-autohide-20261030/`。

实际 Tauri 隔离候选使用 `Naoko.DitaList.RustPreview.EdgeAutoHide` 和 `.local/edge-autohide/profile`：15:20 启动，进程树仅含宿主、WebView2 子进程为 0，运行日志成功记录原生栏 `floating` 状态和矩形；随后经自身 `--quit` 正常退出。测试期间已安装实例 PID 11072 始终保留，未覆盖程序或数据；快捷键占用日志来自该实例已有的注册。Computer Use 的 `list_windows`／`list_apps` 未返回隔离原生工具栏，未对用户正在使用的主窗口注入操作。细线显示、鼠标移入／移出、输入拖离及混合 DPI 的实际交互仍待用户覆盖安装验证。
