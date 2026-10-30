# 冻结基线功能对照

来源 `1d51ac981db7ea1db0266a58ea72908dba698b7e`。`81f307e` 导航与筛选为另列的已提交增量。以下区分业务验证、浏览器实际组件 fixture 和真实 Tauri 验证；后两者不能互相替代。

| 功能 | 迁移位置 | 自动验证 | 桌面证据 |
| --- | --- | --- | --- |
| 创建、编辑、子任务、优先级、置顶、排序、复制 | core/service、App | 核心 CRUD/复制/完整性；Web 连续编辑串行写 | 中文创建、日期、标签和核心保存已实测 |
| 重复任务与历史 | core/recurrence | 月末31号、闰年、工作日、重复完成和子任务重置 | 主要依赖核心边界测试 |
| 中文快速输入 | core/quick_input、FloatingApp | 自然语言、上下文标签合并、同号失败重试 | 真实 WebView2 中文输入、Esc 销毁和草稿恢复 |
| 清单、分组、标签、过滤器 | core/service、navigation、AppNavigation | CRUD、引用清理、排序、互换／冲突 | 见本轮桌面验收记录 |
| 月／周／日／议程日历及拖放 | Calendar、core TaskUpdate | 实际组件四模式；业务日期校验 | 见本轮桌面验收记录，浏览器模式不计作完整拖放验收 |
| 四象限 | Matrix、TaskUpdate | 具体任务命令接入，保留生产组件 | 见本轮桌面验收记录 |
| 习惯 | Tools、HabitRecord | 核心记录及实际组件提交 | 见本轮桌面验收记录 |
| 专注和休息 | core/focus、Tools | 无视图推进、到期竞争、历史只写一次、暂停目标锁定 | 见生命周期记录 |
| 设置、主题、快捷键、数据状态 | App、desktop | 类型验证、核心设置、真实组件深浅主题 | 设置与 MCP 配置已实测；跨 DPI 见未覆盖项 |
| JSON／CSV 导入、备份、损坏恢复 | core/import、storage | CSV 幂等、合并不覆盖、兼容包装、损坏保全、版本拒绝 | Windows 实际文件 I/O 集成测试 |
| 回收站、恢复、永久删除及确认偏好 | core/service、App | 本地权限和确认、整站操作、Agent 权限拒绝 | 永久删除逻辑用隔离核心测试覆盖 |
| Agent 新建／修改审核 | core/service、AgentReview | 基础版本冲突、修改不提前覆盖、差异／批量审批组件 | 实际标准 stdio 创建 pending；无自动审核遮挡 |
| MCP 发现、身份、幂等、开关 | crates/mcp、host | 官方 SDK stdio、动态端口、过期身份、重启、并发、失败关闭和终态回执 | 实际 Tauri 核心与 stdio 链路通过 |
| 原生悬浮栏与提醒 | desktop/native | 原生生产源码、消息和显示回执；核心提醒测试 | 原生工具窗视觉／多屏覆盖限制见验证报告 |
| 提醒恢复、延后、失效 | core/reminders | 已提示／已处理、跨午夜、提前量、改期／关提醒、通知幂等 | 系统 Toast 与原生视觉不能由核心测试代替 |
| 窗口销毁、退出交接 | host、desktop、App/FloatingApp | 草稿失败／IME／在途提交、退出拒绝与取消 | 实际窗口释放、进程树与清理见生命周期报告 |
| 导航编辑与任务筛选（81f增量） | navigation、AppNavigation、TaskFilterControl | 8项核心导航检查、实际组件排序隐藏／筛选会话 | 来源单独记录，未混入未提交改动 |

保留业务与风格不等于照搬宿主。原 Electron IPC、Node MCP、Web 权威保存和 React 提醒计时器已从运行路径替换为 Rust 核心。原有 TypeScript 业务测试保留为迁移参考；实际命令权威由 Rust 测试验证。
