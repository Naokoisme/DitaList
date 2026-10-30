# 源码来源

- 原项目：`D:\dida-local`，冻结基线 `1d51ac981db7ea1db0266a58ea72908dba698b7e`。
- 提取方式：`git archive` 按指定提交提取 React、样式、资源、测试及 Vite 入口；未复制原工作区未提交文件。
- 2026-10-30 用户授权另一会话完成本阶段并交接 Rust。导航与任务筛选增量单独采用已提交的 `81f307e192ac58e2a45e70e2c7f65b781cf142dd`；通过 `git show` 取来源文件，业务写入重新接入 Rust。
- 增量范围：两列导航排序／隐藏、自定义项目重命名、根组清单拖动排序、每视图任务筛选、日期范围与完成日期、搜索跳转清除目标筛选。系统名称不允许修改；没有增加标签层级。
- 新项目独立初始化 Git，原项目与日用安装均不由本任务修改。Android、Electron 和 Node MCP 未进入运行包。
- 产品版本保持 `0.0.0`。候选只使用独立应用身份 `Naoko.DitaList.RustPreview`，以本地源码提交与 SHA-256 区分。
- 2026-10-30 用户明确要求将这一版推送至现有远端，并全面转向 Rust。目标为 `https://github.com/Naokoisme/DitaList.git` 的 `main`；远端旧头为 `f6581575d16e8789e0afd70458dc4e6fc1d04ccf`。合并保留原项目截至 `81f307e192ac58e2a45e70e2c7f65b781cf142dd` 的完整提交历史，合并后的工作树采用 Rust 工程。原本地目录保持只读；本次仅推送源码，不创建 GitHub Release。
