use rmcp::{
    ServerHandler, ServiceExt, handler::server::wrapper::Parameters, model::*, tool, tool_handler,
    tool_router, transport::stdio,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    query: Option<String>,
    include_deleted: Option<bool>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    id: String,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestArgs {
    request_id: String,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteArgs {
    request_id: String,
    id: String,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateArgs {
    /// Generate once per intended operation. Reuse unchanged on every retry.
    request_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repeat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reminder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}
#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchSchema {
    title: Option<String>,
    content: Option<String>,
    list_id: Option<String>,
    start_date: Option<String>,
    due_date: Option<String>,
    time: Option<String>,
    end_time: Option<String>,
    priority: Option<u8>,
    tags: Option<Vec<String>>,
    pinned: Option<bool>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateArgs {
    request_id: String,
    id: String,
    #[schemars(with = "PatchSchema")]
    patch: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_version: Option<u64>,
}

#[derive(Clone)]
struct Bridge {
    path: PathBuf,
}
#[tool_router]
impl Bridge {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
    async fn call<T: Serialize>(&self, method: &str, args: T) -> CallToolResult {
        match ditalist_mcp::call(&self.path, method, serde_json::to_value(args).unwrap()).await {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(
                json!({"code":error.code,"message":error.message}).to_string(),
            )]),
        }
    }
    #[tool(
        name = "dida_list_list_tasks",
        description = "查询本机 DitaList 任务。Agent pending 任务尚未获用户批准。query 按标题、正文或标签进行子串搜索。"
    )]
    async fn list_tasks(&self, Parameters(args): Parameters<ListArgs>) -> CallToolResult {
        self.call("tasks.list", args).await
    }
    #[tool(
        name = "dida_list_get_task",
        description = "读取正式任务及当前版本，待审核修改不会提前覆盖正式任务。"
    )]
    async fn get_task(&self, Parameters(args): Parameters<IdArgs>) -> CallToolResult {
        self.call("tasks.get", args).await
    }
    #[tool(
        name = "dida_list_create_task",
        description = "提交新增任务申请，用户批准前不加入正式待办和提醒。requestId 必须由调用方首次生成并在重试时复用，不能每次生成新号。结果不明确时先用 get_request 查询。"
    )]
    async fn create_task(&self, Parameters(args): Parameters<CreateArgs>) -> CallToolResult {
        self.call("tasks.create", args).await
    }
    #[tool(
        name = "dida_list_update_task",
        description = "提交修改申请，用户批准后生效。使用同一 requestId 重试；不能通过修改批准任务或永久删除。"
    )]
    async fn update_task(&self, Parameters(args): Parameters<UpdateArgs>) -> CallToolResult {
        self.call("tasks.update", args).await
    }
    #[tool(
        name = "dida_list_delete_task",
        description = "将任务移入回收站，可由用户恢复。requestId 在同一次操作及重试间保持不变。MCP 不提供永久删除。"
    )]
    async fn delete_task(&self, Parameters(args): Parameters<DeleteArgs>) -> CallToolResult {
        self.call("tasks.delete", args).await
    }
    #[tool(
        name = "dida_list_get_request",
        description = "用原 requestId 核对保存结果。unknown 表示不能确认，不允许换号自动重放；去重记录至少保留30天。"
    )]
    async fn get_request(&self, Parameters(args): Parameters<RequestArgs>) -> CallToolResult {
        self.call("requests.get", args).await
    }
}
#[tool_handler]
impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("DitaList Rust Preview", env!("CARGO_PKG_VERSION")))
            .with_instructions("DitaList 本地任务服务。所有写操作须保留业务 requestId。创建与修改等待本地用户审核；MCP 通道必须由用户开启。")
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let mut path = ditalist_mcp::contact_path(&ditalist_mcp::default_data_dir());
    while let Some(arg) = args.next() {
        if arg == "--contact" {
            path = PathBuf::from(
                args.next()
                    .ok_or_else(|| anyhow::anyhow!("--contact needs a path"))?,
            );
        } else {
            anyhow::bail!("unknown argument: {arg}");
        }
    }
    let service = Bridge::new(path).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
