# 主窗口水滴式展开与绘制交接

主窗口从悬浮栏的实际位置流出：前端圆润膨大，尾部暂时连接源栏，曲线收腰逐渐舒展，最终形成圆角主窗口。动画时长为 820ms；点击后的准备等待与动画播放时长分开记录。

## 当前行为

- 冷启动、保留 30 秒内的隐藏主窗、最小化恢复共用同一展开路径。已可见的主窗只导航和聚焦；关闭到托盘后仍按 30 秒释放，不为动画常驻完整 WebView。
- `mainMotionFrames` 用同一条曲线路径生成四个源方向的轮廓。外壳变形，真实 App 保持最终布局并等比缩放，文字不随收腰扭曲。完成或取消后清除临时路径、尺寸、变换和禁用交互状态。
- 主 HWND 局部禁用 DWM 默认过渡，避免系统恢复动画叠加。最小化恢复先遮蔽窗口再恢复位置；暖启动先裁到源栏范围，由真实 WebView 绘出新首帧后才解除裁剪，避免旧整窗先显示。
- `mainShellReady` 在动效监听器和外壳就绪时发出，界面订阅与业务快照加载并行进行。React StrictMode 取消的旧 effect 不得发起打开；关闭或最小化后迟到的 `ready` 不得重新拉起窗口。
- 细线与栏开始转场前先生成像素，再切到 layered 绘制；终点先提交完整帧，退出 Rust 可变借用后才撤销 layered 并同步重画原生按钮。交给 Web 时先隐藏，恢复时先布局再显示。静态与动画文字统一灰度抗锯齿，去掉只在动画中出现的边框。
- 修正数据更新期间画布重建失败的恢复：依据实际窗口样式撤销 layered，不依赖旧画布对象仍然存在。正常、取消、错误收尾均释放临时绘制资源，不留常驻动画计时器。

## 观测与验证边界

`runtime.jsonl` 串行写入完整 JSON 行，记录 `requested`、`shell_ready`、`prepare_sent`、`prepared`、`source_frame`、`first_frame`、`finished` 等阶段。原生请求耗时、前端 `performance.now()` 时间与宿主收到完成及收尾时刻分开保存，避免把 IPC 延迟算成动画本身。

- Rust 桌面检查使用 `cargo test --locked -p ditalist-desktop desktop:: -- --test-threads=1`：19 项通过，1 项帧导出器默认忽略。首轮并行图形测试曾出现一次 `0xc0000005`；两个图形测试分别重跑及完整串行检查通过，未将这次异常视为已定位的图形驱动问题。
- 最终 820ms 轮廓的真实 React 组件回归：`node --import tsx --test --test-name-pattern="main morph|retained main" tests/web-ui.test.ts`，6 项通过。覆盖浅深主题、路径生效和释放、固定布局与窄窗、首帧交接、缓存重开、减少动画、最小化中断及过期完成回报。此前另有 3 项窗口控制按钮悬停检查通过。
- `npm run build`（含 TypeScript 检查）、`cargo fmt --all --check` 与 `cargo clippy --locked -p ditalist-desktop --bin DitaListRust -- -D warnings` 通过。
- 隔离的实际 WebView2 已走通冷开及多次最小化恢复；阶段日志位于本地 `reports/motion-fix-20261030/` 与 `.local/motion-fix/`。其中诊断 Release（SHA-256 `2844bd77ac50eb2a2f0aaa1fa3a656da17d059a05737848dc771238953856439`）验证的是相同宿主交接和前一轮 680ms 轮廓，不能当作最终 820ms 水滴轮廓的逐帧桌面验收。
- 真实桌面验证被用户通过物理 Esc 中止，未继续自动操作窗口。因此最终轮廓的完整桌面录像、普通 toolwindow 的连续收展，以及混合 DPI 仍未完成自动验收。用户认可当前方向并授权提交源码，不等同于这些项目全部验证通过。

`--motion-probe` 与 `--bar-ui-probe` 仅在 Debug 或显式 `motion-diagnostics` 构建中启用。后者把隔离栏临时改为可被辅助工具发现的 APPWINDOW，生产候选保持 TOOLWINDOW；它不改变绘制和业务输入规则。诊断构建必须使用独立应用标识及 `DITALIST_DATA_DIR`；正常打包不启用该 feature，不指向日用数据。

本轮保留原版本号与业务数据格式。早期方案和验证记录见[此前动效记录](motion-20261030.md)。
