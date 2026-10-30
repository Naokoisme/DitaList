use ditalist_contracts::*;
use ditalist_core::CoreService;
use ditalist_mcp::{
    Contact, Gateway, LocalRequest, LocalResponse, call, contact_path, read_frame, write_frame,
};
use serde_json::{Value, json};
use std::sync::Arc;

fn gateway(core: CoreService, path: &std::path::Path) -> Gateway {
    Gateway::new(core, path, Arc::new(|| {}), Arc::new(|_| {}))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_write_is_retained_across_queries_and_repeated_close_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let server = gateway(core.clone(), dir.path());
    server.set_enabled(true).await.unwrap();
    let path = contact_path(dir.path());
    let obstruction = dir.path().join("database.rust.json");
    std::fs::create_dir(&obstruction).unwrap();
    let original = json!({"requestId":"failed-save","title":"恢复存储后仍须保存这条申请"});
    assert_eq!(
        call(&path, "tasks.create", original.clone())
            .await
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(
        call(&path, "requests.get", json!({"requestId":"failed-save"}))
            .await
            .unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        call(
            &path,
            "tasks.create",
            json!({"requestId":"failed-save","title":"不能改掉原请求"})
        )
        .await
        .unwrap_err()
        .code,
        "conflict"
    );
    for _ in 0..2 {
        assert_eq!(server.set_enabled(false).await.unwrap_err().code, "storage");
        assert_eq!(server.info().state, "closing_failed");
        assert!(path.exists());
        assert!(core.get_request("failed-save").is_none());
    }
    assert_eq!(
        call(
            &path,
            "tasks.create",
            json!({"requestId":"too-late","title":"不得受理"})
        )
        .await
        .unwrap_err()
        .code,
        "closing"
    );
    std::fs::remove_dir(&obstruction).unwrap();
    server.set_enabled(false).await.unwrap();
    assert_eq!(server.info().state, "closed");
    assert!(!path.exists());
    assert_eq!(core.snapshot().data.tasks.len(), 1);
    assert_eq!(core.snapshot().data.tasks[0].title, original["title"]);
    assert!(core.get_request("failed-save").is_some());
    assert!(core.get_request("too-late").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_reopen_rejects_stale_identity_and_releases_each_listener() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let server = gateway(core, dir.path());
    let path = contact_path(dir.path());
    server.set_enabled(true).await.unwrap();
    let old: Contact = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for _ in 0..5 {
        let previous: Contact = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        server.set_enabled(false).await.unwrap();
        assert!(
            tokio::net::TcpStream::connect(&previous.address)
                .await
                .is_err()
        );
        server.set_enabled(true).await.unwrap();
        let current: Contact = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut stream = tokio::net::TcpStream::connect(&current.address)
            .await
            .unwrap();
        write_frame(
            &mut stream,
            &LocalRequest {
                instance: old.instance.clone(),
                token: old.token.clone(),
                method: "tasks.list".into(),
                params: json!({}),
            },
        )
        .await
        .unwrap();
        let response: LocalResponse = read_frame(&mut stream).await.unwrap();
        assert_eq!(response.error.unwrap().code, "identity");
        assert!(call(&path, "tasks.list", json!({})).await.is_ok());
    }
    server.set_enabled(false).await.unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_update_becoming_conflict_is_settled_and_does_not_trap_shutdown() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let created = core
        .execute(
            CoreCommand {
                request_id: "local-create".into(),
                operation: Operation::TaskCreate {
                    input: json!({"title":"原任务"}),
                },
            },
            Caller::Local,
        )
        .unwrap();
    let id = created.result["taskId"].as_str().unwrap().to_owned();
    let version = core.snapshot().entity_versions[&id];
    let server = gateway(core.clone(), dir.path());
    server.set_enabled(true).await.unwrap();
    let path = contact_path(dir.path());
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(dir.path().join("database.rust.json"))
        .unwrap();
    let request = json!({"requestId":"storage-then-conflict","id":id,"expectedVersion":version,"patch":{"title":"过期提案"}});
    assert_eq!(
        call(&path, "tasks.update", request.clone())
            .await
            .unwrap_err()
            .code,
        "storage"
    );
    drop(locked);
    core.execute(
        CoreCommand {
            request_id: "local-newer".into(),
            operation: Operation::TaskUpdate {
                id: id.clone(),
                patch: json!({"title":"用户最新编辑"}),
                expected_version: None,
            },
        },
        Caller::Local,
    )
    .unwrap();
    server.set_enabled(false).await.unwrap();
    assert_eq!(server.info().state, "closed");
    let receipt = core.get_request("storage-then-conflict").unwrap();
    assert_eq!(receipt.status, "rejected");
    assert_eq!(receipt.result["error"]["code"], "conflict");
    assert_eq!(core.snapshot().data.tasks[0].title, "用户最新编辑");
    server.set_enabled(true).await.unwrap();
    assert_eq!(
        call(
            &path,
            "requests.get",
            json!({"requestId":"storage-then-conflict"})
        )
        .await
        .unwrap()["receipt"]["status"],
        "rejected"
    );
    assert_eq!(
        call(&path, "tasks.update", request).await.unwrap()["status"],
        "rejected"
    );
    server.set_enabled(false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_identity_and_receipts_survive_channel_restart() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let server = gateway(core.clone(), dir.path());
    let path = contact_path(dir.path());
    assert_eq!(
        call(&path, "tasks.list", json!({})).await.unwrap_err().code,
        "disabled"
    );
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:27182").await.ok();
    server.set_enabled(true).await.unwrap();
    let first: Contact = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let command = json!({"requestId":"integration-create","title":"MCP 集成验证"});
    let receipt = call(&path, "tasks.create", command.clone()).await.unwrap();
    assert_eq!(receipt["status"], "pending");
    assert_eq!(
        call(&path, "tasks.create", command.clone()).await.unwrap(),
        receipt
    );
    assert_eq!(
        call(
            &path,
            "tasks.create",
            json!({"requestId":"integration-create","title":"不同参数"})
        )
        .await
        .unwrap_err()
        .code,
        "conflict"
    );
    assert_eq!(core.snapshot().data.tasks.len(), 1);
    assert_eq!(core.snapshot().today_count, 0);
    let mut stream = tokio::net::TcpStream::connect(&first.address)
        .await
        .unwrap();
    write_frame(
        &mut stream,
        &LocalRequest {
            instance: first.instance.clone(),
            token: "wrong".into(),
            method: "tasks.list".into(),
            params: json!({}),
        },
    )
    .await
    .unwrap();
    let response: LocalResponse = read_frame(&mut stream).await.unwrap();
    assert_eq!(response.error.unwrap().code, "identity");
    assert_eq!(
        call(&path, "tasks.purge", json!({"id":"any"}))
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    server.set_enabled(false).await.unwrap();
    assert!(!path.exists());
    assert_eq!(server.info().state, "closed");
    server.set_enabled(true).await.unwrap();
    let second: Contact = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_ne!(first.instance, second.instance);
    assert_ne!(first.token, second.token);
    assert_eq!(call(&path, "tasks.create", command).await.unwrap(), receipt);
    assert_eq!(
        call(
            &path,
            "requests.get",
            json!({"requestId":"integration-create"})
        )
        .await
        .unwrap()["receipt"],
        receipt
    );
    server.set_enabled(false).await.unwrap();
    drop(server);
    drop(core);
    drop(reserved);
    let restored = CoreService::open(dir.path()).unwrap();
    assert!(restored.get_request("integration-create").is_some());
    assert_eq!(restored.snapshot().data.tasks.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_retries_and_shutdown_do_not_duplicate_or_write_after_closed() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let server = gateway(core.clone(), dir.path());
    server.set_enabled(true).await.unwrap();
    let path = contact_path(dir.path());
    let mut jobs = Vec::new();
    for _ in 0..12 {
        let path = path.clone();
        jobs.push(tokio::spawn(async move {
            call(
                &path,
                "tasks.create",
                json!({"requestId":"parallel-same","title":"一次"}),
            )
            .await
        }));
    }
    for job in jobs {
        assert_eq!(job.await.unwrap().unwrap()["status"], "pending")
    }
    assert_eq!(core.snapshot().data.tasks.len(), 1);
    let mut jobs = Vec::new();
    for index in 0..12 {
        let path = path.clone();
        jobs.push(tokio::spawn(async move {
            call(
                &path,
                "tasks.create",
                json!({"requestId":format!("closing-{index}"),"title":"关闭边界"}),
            )
            .await
        }));
    }
    tokio::task::yield_now().await;
    server.set_enabled(false).await.unwrap();
    let saved_at_close = core.snapshot().data.tasks.len();
    for job in jobs {
        let _ = job.await.unwrap();
    }
    assert_eq!(core.snapshot().data.tasks.len(), saved_at_close);
    assert!(!path.exists());
    for index in 0..12 {
        if let Some(receipt) = core.get_request(&format!("closing-{index}")) {
            assert_eq!(receipt.status, "pending");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_sdk_client_discovers_and_calls_the_real_stdio_binary() {
    use rmcp::{
        ServiceExt,
        model::{CallToolRequestParams, ClientConfig},
        transport::TokioChildProcess,
    };
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let server = gateway(core.clone(), dir.path());
    server.set_enabled(true).await.unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_ditalist-mcp"));
    command.arg("--contact").arg(contact_path(dir.path()));
    let client = ClientConfig::default()
        .serve(TokioChildProcess::new(command).unwrap())
        .await
        .unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 6);
    assert!(tools.iter().any(|t| t.name == "dida_list_get_request"));
    assert!(
        !tools
            .iter()
            .any(|t| t.name.contains("purge") || t.name.contains("approve"))
    );
    let created = client
        .call_tool(
            CallToolRequestParams::new("dida_list_create_task").with_arguments(
                json!({"requestId":"stdio-create","title":"标准 MCP"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_ne!(created.is_error, Some(true));
    assert_eq!(core.snapshot().pending_count, 1);
    let created_json = serde_json::to_value(&created).unwrap();
    let value: Value =
        serde_json::from_str(created_json["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(value["status"], "pending");
    let id = value["result"]["taskId"].as_str().unwrap().to_owned();
    core.execute(
        CoreCommand {
            request_id: "approve-local".into(),
            operation: Operation::AgentApprove { id: id.clone() },
        },
        Caller::Local,
    )
    .unwrap();
    let update = client
        .call_tool(
            CallToolRequestParams::new("dida_list_update_task").with_arguments(
                json!({"requestId":"stdio-update","id":id,"patch":{"title":"等用户审核"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_ne!(update.is_error, Some(true));
    assert_eq!(core.snapshot().data.tasks[0].title, "标准 MCP");
    server.set_enabled(false).await.unwrap();
    let disabled = client
        .call_tool(
            CallToolRequestParams::new("dida_list_list_tasks")
                .with_arguments(json!({}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(disabled.is_error, Some(true));
    client.cancel().await.unwrap();
}
