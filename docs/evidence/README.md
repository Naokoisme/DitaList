# 本地验证证据归档

归档日期：2026-10-30（Asia/Shanghai）。这里保存此前各轮实现中已形成的资料，原件留在本地 `reports/`；此次归档没有重新执行桌面验收。

共 35 份 JSON 报告与 14 份独立图像。对应源码提交、时间、退出码、失败状态和未验证范围均保留。每份文件的来源、原始与公开副本 SHA-256，以及调整字段见 [manifest.json](manifest.json)。没有提交号的报告按自身时间和配套说明辨识，不能推定来自当前 Release。

## 资料目录

| 目录或文件 | 内容与边界 |
| --- | --- |
| [artifact-verification.json](artifact-verification.json) | 首轮 `225c8fa` 的包体与 ZIP 核对 |
| [installation-20261030](installation-20261030/) | 首轮隔离安装、运行中覆盖被拒、退出后覆盖、数据哈希与卸载；失败记录未移除 |
| [resources-20261030](resources-20261030/) | 首轮 Rust／Electron 小样本进程树、私有内存与 CPU 采样；条件见[首轮报告](../validation.md) |
| [floating-feedback-20261030](floating-feedback-20261030/) | 拖柄专项的基线／修复候选、源码哈希、无 WebView 启动与浅深输入截图 |
| [package-20261030-de3d620](package-20261030-de3d620/) | `de3d620` 历史候选核对 |
| [edge-autohide-20261030](edge-autohide-20261030/) | 贴边收起专项的隔离启动／退出与历史包体验证 |
| [bar-polish-20261030](bar-polish-20261030/) | 圆角、恢复悬停的运行记录和 `9e0220d` 包体验证 |
| [navigation-feedback](navigation-feedback/) | 导航长按原位编辑的浅深组件截图 |
| [ios-motion-20261030](ios-motion-20261030/) | 早期原生栏帧导出、WebView 冷开最终画面、回归截图及 `120211c` 历史包体验证 |
| [motion-fix-20261030](motion-fix-20261030/) | 最终水滴预览及上一轮矩形流出方案的对照资料 |

## 动效图的含义

[main-droplet-preview.gif](motion-fix-20261030/main-droplet-preview.gif) 为最终 820ms 水滴轮廓的真实 App 组件逐帧预览，使用隔离测试数据。它展示轮廓设计，不是 Windows 整个启动过程的实时录屏。

`main-flow-preview.gif` 与 `main-flow-keyframes.png` 是已被后续水滴轮廓替代的旧方案，仅用于保留设计演进。`native-bar-motion.gif`／`native-bar-keyframes.png` 是早期生产绘制路径的帧导出，不能证明当前普通工具窗口连续收展没有闪烁。当前行为和真实桌面尚未覆盖的项目见[水滴式动效记录](../motion-flow-20261030.md)。

## 公开副本的处理

- 18 份 JSON 保持原始字节；17 份仅归一化本机绝对路径或删除临时 UI 定位字段，具体字段逐项写入 manifest。项目内路径改为相对路径，其他安装／旧仓库路径使用 `<preview-install>`、`<legacy-repo>` 标记。
- 保留采样时的进程号、时间、资源数值、源码提交和文件／数据库哈希；没有上传数据库正文。图像保持原始字节。
- 本机清理流水、原始日志、任务库及备份、浏览器 profile、MCP 凭据、41 张动画中间帧和历史安装包不并入文档。未恢复此前废弃的 HTML 设计。
- 仓库外的认可视觉稿与 [floating-bar.png](../floating-bar.png) 完全相同，只保留一份。架构讨论原文已单独[归档](../history/DitaList-Tauri-架构草案.md)。
