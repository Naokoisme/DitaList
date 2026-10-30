# DitaList 文档索引

DitaList 当前维护主线为 Tauri＋Rust，平台为 Windows x64。文档保留产品决定、来源提交和每轮验证边界；原 Electron／Android 代码仍可从 Git 历史查阅。

## 使用与开发

| 文档 | 内容 |
| --- | --- |
| [项目说明](../README.md) | 下载、运行、开发与打包入口 |
| [当前 Release 说明](release-20261030.md) | 当前 Rust 预览版的安装方式、产物与验证范围 |
| [架构](architecture.md) | Rust 核心、原生栏、按需 WebView、MCP、提醒与存储规则 |
| [接口合同](interfaces.md) | 业务命令、版本检查、状态通知与窗口协作 |
| [MCP 接入](mcp.md) | stdio 配置、动态地址发现、请求号和权限 |
| [命令 Schema](schema/command.json) | 从 Rust 共享合同生成的命令定义 |
| [功能对照](function-matrix.md) | 原功能的迁移位置和验证情况 |
| [源码来源](source-provenance.md) | 冻结基线、增量、历史保留及远端交付范围 |

## 交互与设计

| 文档 | 内容 |
| --- | --- |
| [安装反馈](feedback-20261030.md) | 统一「＋」新增、Agent 审核、导航原位排序／隐藏与设置入口 |
| [悬浮栏专项](floating-bar-feedback.md) | 拖柄、贴边白色细线、圆角和窗口恢复焦点 |
| [当前水滴式展开](motion-flow-20261030.md) | 820ms 轮廓、冷／暖／最小化统一路径、原生帧交接与验收边界 |
| [此前动效记录](motion-20261030.md) | 早期动效实现与当时的检查结果 |
| [悬浮栏视觉稿](floating-bar.png) | 讨论阶段认可的设计参考，不作为运行截图 |
| [早期架构讨论归档](history/DitaList-Tauri-架构草案.md) | 仓库外草案原文与历史决策；实际行为以上述当前文档为准 |

## 验证资料

- [首轮迁移验证报告](validation.md)：业务、MCP、资源和隔离安装检查，保留首轮结果与未覆盖项。
- [证据归档](evidence/README.md)：35 份结构化报告、14 份独立图像，以及原始／公开副本的哈希与路径调整记录。
- [生产 React 组件截图](../tests/web-evidence/)：随现有测试保留的截图；浏览器组件验证与实际 Tauri 验收分别记录。

原始日志、任务数据库、备份数据、运行凭据与中间帧不属于公开文档。历史试用包不补发，当前 Release 提供同一次源码构建的 Setup、免安装包、文档包和校验清单。
