# DitaList

Naoko 的个人离线任务管理应用，面向 Windows 和 Android。任务、日历、习惯和专注数据保存在本机，无需账号、服务器或订阅。

当前版本为 Beta，适合个人使用和日常任务管理。电脑与手机各自保存数据，需要在设备之间迁移时，可使用应用内的导出与导入功能。

## 直接使用

- Windows：从 [Releases](https://github.com/Naokoisme/DitaList/releases) 下载 `DitaList-…-Setup.exe`，双击安装。安装器提供开始菜单和可选桌面快捷方式；默认仅为当前用户安装，无需管理员权限。
- Windows 便携版：解压后运行目录中的 `DitaList.exe`，需保留完整目录。源码开发也可使用 `启动DitaList.cmd`。
- Android：安装构建生成的 APK。最低 Android 8.0，使用系统 WebView，不申请联网权限。
- 数据导入：在“设置 → 数据与备份 → 导入数据”中选择 CSV 任务列表或 JSON 备份。导入会合并现有内容，并保留无法转换的复杂规则原文。

Windows 数据保存在 `%APPDATA%\DidaLocal\data\database.json`，自动备份位于同一目录。Android 数据保存在应用私有目录。电脑与手机各自离线存储，跨设备迁移使用 JSON 导出、导入。

Windows 升级时先在系统托盘中选择“退出 DitaList”，再运行新版 Setup。安装器会沿用上次的安装目录，保留已有任务和设置；便携版切换到安装版也使用同一数据目录。可在 Windows“已安装的应用”中卸载 DitaList，卸载会保留本地数据，重新安装后继续使用。

请定期导出一份独立备份。卸载 Android 应用或清除其应用数据会删除私有数据，卸载前先导出。

## 当前功能

任务支持清单、文件夹、标签、过滤器、优先级、子任务、描述、搜索、置顶、复制、完成历史和垃圾桶恢复。日期支持中文快速输入、跨日任务，以及每天、工作日、每周、每月和每年重复；月末与闰年会保持稳定的日期规则。

日历提供月、周、日和议程视图，支持农历、清单筛选、待安排任务、拖动改期与改时，以及长按范围创建任务。应用还提供四象限、番茄专注、每日习惯、浅色／深色主题和手机布局。

Windows 版本提供托盘图标和桌面悬浮球，可在“设置 → 通用 → 显示悬浮球”中打开或收起，也可单击托盘切换显示。小球显示“今天”的未完成任务数（包含逾期）；点击后展开快速输入，内容变长时先增宽，再自动换行。`Enter` 添加，`Shift+Enter` 换行，`Esc` 收起并保留当前草稿；草稿仅保留到程序退出。按 `Ctrl+Alt+Space` 可直接打开输入框，拖动小球可调整位置。

语音可沿用微信输入法自身的语音按钮，转写文字与键盘输入一样自动延展。DitaList 尚未接入独立语音服务。关闭主窗口后，应用会继续留在托盘中，可从托盘重新打开或退出。

## Beta 说明

- 这是本地单机应用，不提供云同步、团队协作或在线日历服务。
- Windows 提醒需要程序保持运行；退出、关机或休眠期间不会提醒。
- Android 提醒由系统闹钟排程，可能受到手机省电策略影响；通知权限需要在手机上允许。
- 当前版本暂未覆盖附件、桌面小组件和全部复杂重复规则。
- 专注计时可以跨页面继续，但退出程序后不会保留当前进行中的进度。

## 开发

```powershell
npm install
npm run build
npm start
```

`npm run dev` 可启动网页开发模式。网页模式使用浏览器 IndexedDB，与 Windows 和 Android 的本地数据相互独立。

## 检查与打包

```powershell
npm run typecheck
npm test
npm run test:ui
node scripts/ui-smoke.mjs --electron-only

# 从干净的本地 main 构建 Windows 便携版
npm run package:win

# 从干净的本地 main 构建单文件 Windows 安装包
# 需要 Inno Setup 6.5+；自定义位置可设置 INNO_SETUP_COMPILER
npm run package:setup
# 可单独指定发布文件名标签，不修改程序版本号
npm run package:setup -- --label 0.0.0-beta.6

# 构建 Android APK
pwsh -File scripts/build-android.ps1
```

产物位于 `release/`。Windows Setup 使用 [Inno Setup](https://jrsoftware.org/) 封装完整程序，生成 EXE、SHA-256 校验文件及构建信息；构建时的临时程序目录会在成功后清理。Windows 便携版和 Android APK 也会生成构建信息与文件校验清单，便于确认产物来源和完整性。
