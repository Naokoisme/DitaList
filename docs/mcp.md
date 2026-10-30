# MCP 接入

先启动 DitaList Rust Preview，在设置的 Agent 页开启 MCP。通道默认关闭并记住用户选择。配置使用实际候选目录中的程序路径；设置页可复制完整配置。

```json
{
  "mcpServers": {
    "ditalist": {
      "command": "D:\\ditalist-rust\\target\\release\\ditalist-mcp.exe",
      "args": ["--contact", "C:\\Users\\你的用户名\\AppData\\Roaming\\DitaListRustPreview\\data\\mcp\\contact.json"]
    }
  }
}
```

Agent 使用标准 MCP stdio 协议，不需要配置端口。连接程序在每次调用前读取当前联系文件，再核对应用、实例及随机凭据；核心使用系统分配的回环端口。联系文件只授予当前 Windows 用户访问，不进入备份或日志。

| 工具 | 行为 |
| --- | --- |
| dida_list_list_tasks | 查询任务，可包含回收站；query 为标题、正文和标签子串 |
| dida_list_get_task | 返回正式任务及实体版本 |
| dida_list_create_task | 新建申请，先进入 Agent 待确认 |
| dida_list_update_task | 修改申请，本地审批并核对基础版本后生效 |
| dida_list_delete_task | 移入回收站 |
| dida_list_get_request | 使用原 requestId 核对回执及当前审核状态 |

写工具必须传 `requestId`，由调用方首次生成并在该操作的全部重试中复用。同号同参返回原回执，同号异参拒绝；MCP 消息 id 不替代业务请求号。更新可传 `expectedVersion`。回复丢失时先查询原号；`unknown` 不授权更换编号自动重放。回执至少保留 30 天，未完成和待审核依赖继续保留。

关闭通道后停止受理新操作，已经受理的写操作与回执保存完成后移除联系地址并关闭监听。收尾失败显示“关闭失败”，修复存储后点击“重试关闭”；不会等待用户审核。MCP 不提供审批、永久删除、设置开关等本地权限。

实现使用 [官方 Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)。标准 SDK 客户端测试直接启动真实 stdio 二进制；这证明协议链路兼容，不等同于已经逐一验证所有 Agent 软件的配置界面。
