# DitaList 本地 MCP

DitaList 启动后会在本机创建一个命名管道，MCP stdio 服务通过这个管道读写本地任务。Agent 的创建、修改和删除都先落到本机数据文件；新建任务会带有 Agent 标记，并在 DitaList 中等待用户批准。

在 Agent 的 MCP 配置中加入：

```json
{
  "mcpServers": {
    "ditalist": {
      "command": "node",
      "args": ["D:/dida-local/mcp/server.mjs"]
    }
  }
}
```

也可以把路径换成便携包内的 `resources/app/mcp/server.mjs`。DitaList 和 Node MCP 服务都只使用本机 IPC，不会建立云端连接；启动 MCP 服务前需要先打开 DitaList。若运行多个实例，可为两边设置相同的 `DIDA_LOCAL_MCP_PIPE` 环境变量。

stdio 的标准输出专用于 MCP 协议，诊断信息会写入标准错误流。
