# Android 离线壳

本模块将项目 `dist` 的实际生产界面打包到原生 Android WebView。最低 Android 8.0，需较新的 Android System WebView（建议 Chromium 111 及以后）；应用标识 `local.dida.tasks`，应用名“DitaList”。清单数据保存在应用私有目录，备份通过系统文档选择器读写。

应用未声明 `INTERNET` 权限。`https://dida.local` 只是由 WebView 在本机拦截并返回 APK 内资产的固定来源，不连接网络或服务器。桥接脚本先于 React 执行，所有返回内容经 JSON 编码，不执行备份中的脚本。

## 构建

在项目目录执行：

```powershell
pwsh -File scripts/build-android.ps1 -PrepareOnly
# 合入干净 main 后：
npm run build
pwsh -File scripts/build-android.ps1
```

脚本使用固定版本的官方 OpenJDK 与 Google Android SDK Build Tools/Platform。工具下载到 `tools/android`，首次下载核对官方校验和；以后核对已提取工具的 SHA-256。不会修改系统环境变量，也不需要 Android Studio、Gradle、模拟器或 NDK。

安装包为 `release/DitaList-Android.apk`。签名密钥 `android-native/private/local-release.jks` 及随机生成的密码文件 `android-native/private/signing-password.txt` 不提交 Git，必须长期保留，否则后续安装包无法作为同一应用升级。密码通过临时进程环境变量传给签名工具，不进入命令行或构建日志。该密钥是个人开发包签名，不是公开发行渠道的正式签名服务。

## 数据与提醒

- JSON 保存使用 Android AtomicFile，并另存上一份有效备份。损坏数据保全后才允许恢复写入。
- 导入和导出在系统文件选择器完成实际读写后才返回成功；取消不会报成功或修改任务。
- 原生任务提醒使用普通 AlarmManager，无需精确闹钟权限。系统省电、强行停止及厂商后台限制可能推迟或阻止提醒，不保证准点。
- 每次保存调度最近 128 个待提醒任务；触发后和系统重启后重新排程。全天任务的提醒时间默认 09:00，已过去的提醒不补发。
- Android 13 及以后需要用户允许系统通知。应用不自动修改系统权限或省电设置。
- 卸载应用或清除应用数据会删除私有任务，请先导出备份。电脑与手机之间通过 JSON 导出、导入迁移，没有自动同步。

本模块的编译与签名检查不能代替真实安卓设备上的启动、文件选择器和通知验收。
