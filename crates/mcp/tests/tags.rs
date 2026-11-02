use ditalist_contracts::*;
use ditalist_core::CoreService;
use ditalist_mcp::{Gateway, call, contact_path};
use serde_json::json;
use std::sync::Arc;

fn execute(core: &CoreService, operation: Operation) -> CommandReceipt {
    core.execute(
        CoreCommand {
            request_id: uuid::Uuid::new_v4().to_string(),
            operation,
        },
        Caller::Local,
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tag_filter_uses_authoritative_subtree_and_follows_live_rename() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    for (name, parent) in [
        ("学校", None),
        ("数据结构", Some("学校")),
        ("作业", Some("学校/数据结构")),
    ] {
        execute(
            &core,
            Operation::TagUpsert {
                name: name.into(),
                parent: parent.map(str::to_owned),
                original: None,
            },
        );
    }
    for (id, tags) in [
        ("homework", vec!["学校/数据结构/作业", "学校"]),
        ("legacy-slash", vec!["学校/公开"]),
        ("unrelated", vec!["工作"]),
    ] {
        execute(
            &core,
            Operation::TaskCreate {
                input: json!({"id":id,"title":id,"tags":tags}),
            },
        );
    }
    let gateway = Gateway::new(core.clone(), dir.path(), Arc::new(|| {}), Arc::new(|_| {}));
    gateway.set_enabled(true).await.unwrap();
    let contact = contact_path(dir.path());
    let response = call(&contact, "tasks.list", json!({"tag":"学校"}))
        .await
        .unwrap();
    assert_eq!(response["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(response["tasks"][0]["id"], "homework");
    assert!(response["tagIndex"].as_array().unwrap().iter().any(|tag| {
        tag["id"] == "学校/数据结构/作业" && tag["path"] == json!(["学校", "数据结构", "作业"])
    }));
    execute(
        &core,
        Operation::TagUpsert {
            original: Some("学校/数据结构".into()),
            name: "算法".into(),
            parent: Some("学校".into()),
        },
    );
    let response = call(&contact, "tasks.list", json!({"tag":"学校/算法"}))
        .await
        .unwrap();
    assert_eq!(response["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(response["tasks"][0]["tags"][0], "学校/算法/作业");
    assert_eq!(
        call(&contact, "tasks.list", json!({"tag":"学校/数据结构"}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    gateway.set_enabled(false).await.unwrap();
}
