# DitaList Rust 协作约定

- 仅在本项目实施；来源仓库 `D:\dida-local` 只读，固定基线 `1d51ac981db7ea1db0266a58ea72908dba698b7e`。
- 所有开发、测试与安装候选使用隔离数据，不自动读取 `%APPDATA%\DidaLocal`。
- 保持产品版本 `0.0.0`；候选以提交和 SHA-256 区分，不推送或发布。
- root 管理共享合同、生成产物、清单/锁文件、宿主装配、MCP、打包与集成。
- 核心代理仅修改 `crates/core/`；桌面代理仅修改 `src-tauri/src/desktop/`；Web 代理仅修改 `src/`（不修改生成类型）及其前端测试。
- 共享接口变更先与 root 协调；不要覆盖其他代理的修改。业务规则只由 Rust 核心负责。
- 按 `docs/architecture.md` 和 `docs/interfaces.md` 实现。记录真实测试证据，不把浏览器 fixture 或构建成功当作桌面验收。
