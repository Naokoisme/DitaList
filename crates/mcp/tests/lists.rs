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
async fn parent_list_filter_tracks_real_subtree_moves_without_reassigning_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    for (id, name) in [
        ("school", "学校"),
        ("course", "数据结构"),
        ("homework", "作业"),
        ("work", "工作"),
    ] {
        execute(
            &core,
            Operation::CollectionUpsert {
                collection: "lists".into(),
                value: json!({"id":id,"name":name,"color":"#4772fa","folderId":null,"archived":false,"sortOrder":0}),
            },
        );
        execute(
            &core,
            Operation::TaskCreate {
                input: json!({"id":id,"title":name,"listId":id}),
            },
        );
    }
    for (id, parent) in [("course", "school"), ("homework", "course")] {
        execute(
            &core,
            Operation::ListMove {
                id: id.into(),
                target: ListMoveTarget::List {
                    list_id: parent.into(),
                    position: "inside".into(),
                },
            },
        );
    }
    let gateway = Gateway::new(core.clone(), dir.path(), Arc::new(|| {}), Arc::new(|_| {}));
    gateway.set_enabled(true).await.unwrap();
    let contact = contact_path(dir.path());
    let response = call(&contact, "tasks.list", json!({"listId":"school"}))
        .await
        .unwrap();
    assert_eq!(response["tasks"].as_array().unwrap().len(), 3);
    assert!(response["listIndex"].as_array().unwrap().iter().any(
        |list| list["id"] == "homework" && list["path"] == json!(["学校", "数据结构", "作业"])
    ));
    execute(
        &core,
        Operation::ListMove {
            id: "course".into(),
            target: ListMoveTarget::Group { folder_id: None },
        },
    );
    let response = call(&contact, "tasks.list", json!({"listId":"school"}))
        .await
        .unwrap();
    assert_eq!(response["tasks"].as_array().unwrap().len(), 1);
    let response = call(&contact, "tasks.list", json!({"listId":"course"}))
        .await
        .unwrap();
    assert_eq!(response["tasks"].as_array().unwrap().len(), 2);
    assert!(
        response["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|task| task["id"] == task["listId"])
    );
    assert_eq!(
        call(&contact, "tasks.list", json!({"listId":"missing"}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    gateway.set_enabled(false).await.unwrap();
}
