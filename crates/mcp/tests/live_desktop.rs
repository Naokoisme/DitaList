//! Explicit opt-in smoke against the isolated, actually running desktop host.
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, ClientConfig},
    transport::TokioChildProcess,
};
use serde_json::json;

#[tokio::test]
#[ignore = "Requires a running preview with an isolated profile and MCP enabled"]
async fn actual_desktop_core_accepts_standard_stdio() {
    let path =
        std::env::var("DITALIST_LIVE_CONTACT").expect("Set an isolated preview contact path");
    let request_id = format!("live-desktop-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_ditalist-mcp"));
    command.arg("--contact").arg(&path);
    let client = ClientConfig::default()
        .serve(TokioChildProcess::new(command).unwrap())
        .await
        .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 6);
    let args =
        json!({"requestId":request_id,"title":"MCP 桌面后台验收","content":"隔离测试数据，可丢弃"});
    let first = client
        .call_tool(
            CallToolRequestParams::new("dida_list_create_task")
                .with_arguments(args.as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_ne!(first.is_error, Some(true));
    let receipt = first.structured_content.clone().unwrap();
    assert_eq!(receipt["status"], "pending");
    let retry = client
        .call_tool(
            CallToolRequestParams::new("dida_list_create_task")
                .with_arguments(args.as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(retry.structured_content, first.structured_content);
    let query = client
        .call_tool(
            CallToolRequestParams::new("dida_list_get_request")
                .with_arguments(json!({"requestId":request_id}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        query.structured_content.as_ref().unwrap()["receipt"],
        receipt
    );
    println!(
        "{}",
        json!({"requestId":request_id,"receipt":receipt,"sameIdRetry":"same receipt","transport":"official rmcp stdio"})
    );
    client.cancel().await.unwrap();
}
