use ditalist_core::*;
use serde_json::json;
use std::path::Path;

fn request(operation: Operation) -> CoreCommand {
    CoreCommand {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}

fn block_primary(directory: &Path) {
    let primary = directory.join("database.rust.json");
    std::fs::rename(&primary, directory.join("held-for-save-test.json")).unwrap();
    std::fs::create_dir(primary).unwrap();
}

fn restore_primary(directory: &Path) {
    let primary = directory.join("database.rust.json");
    std::fs::remove_dir(&primary).unwrap();
    std::fs::rename(directory.join("held-for-save-test.json"), primary).unwrap();
}

#[test]
fn failed_write_then_changed_task_settles_to_durable_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    core.execute(
        request(Operation::TaskCreate {
            input: json!({"id":"task","title":"原任务"}),
        }),
        Caller::Local,
    )
    .unwrap();
    let command = request(Operation::TaskUpdate {
        id: "task".into(),
        patch: json!({"title":"Agent 建议"}),
        expected_version: Some(core.snapshot().entity_versions["task"]),
    });

    block_primary(dir.path());
    assert_eq!(
        core.execute(command.clone(), Caller::Agent)
            .unwrap_err()
            .code,
        "storage"
    );
    assert!(core.get_request(&command.request_id).is_none());
    restore_primary(dir.path());
    core.execute(
        request(Operation::TaskUpdate {
            id: "task".into(),
            patch: json!({"title":"用户已改"}),
            expected_version: None,
        }),
        Caller::Local,
    )
    .unwrap();
    let error = core.execute(command.clone(), Caller::Agent).unwrap_err();
    assert_eq!(error.code, "conflict");
    let before = core.snapshot();
    let receipt = core
        .settle_rejected(command.clone(), Caller::Agent, error.clone())
        .unwrap();
    assert_eq!(receipt.status, "rejected");
    assert_eq!(receipt.result["error"]["code"], "conflict");
    assert_eq!(receipt.result["error"]["message"], error.message);
    let after = core.snapshot();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.data, before.data);
    assert_eq!(after.approvals, before.approvals);
    assert_eq!(after.entity_versions, before.entity_versions);
    assert_eq!(
        core.settle_rejected(command.clone(), Caller::Agent, error)
            .unwrap(),
        receipt
    );
    assert_eq!(
        core.execute(command.clone(), Caller::Agent).unwrap(),
        receipt
    );
    assert_eq!(core.snapshot().revision, after.revision);

    let mut different = command.clone();
    different.operation = Operation::TaskUpdate {
        id: "task".into(),
        patch: json!({"title":"不同参数"}),
        expected_version: None,
    };
    assert_eq!(
        core.settle_rejected(different, Caller::Agent, CoreError::new("conflict", "终态"))
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        core.settle_rejected(
            command.clone(),
            Caller::Local,
            CoreError::new("conflict", "终态")
        )
        .unwrap_err()
        .code,
        "conflict"
    );

    drop(core);
    let core = CoreService::open(dir.path()).unwrap();
    assert_eq!(core.get_request(&command.request_id), Some(receipt.clone()));
    assert_eq!(core.execute(command, Caller::Agent).unwrap(), receipt);
    assert_eq!(core.snapshot().data.tasks[0].title, "用户已改");
    assert!(core.snapshot().approvals.is_empty());
}

#[test]
fn rejection_requires_business_error_and_successful_atomic_save() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    core.execute(
        request(Operation::TaskCreate {
            input: json!({"id":"initial","title":"现有任务"}),
        }),
        Caller::Local,
    )
    .unwrap();
    let command = request(Operation::TaskTrash { id: "gone".into() });
    let before = core.snapshot();
    for code in ["storage", "internal", "connection", "unexpected"] {
        assert_eq!(
            core.settle_rejected(
                command.clone(),
                Caller::Agent,
                CoreError::new(code, "可重试或未知错误")
            )
            .unwrap_err()
            .code,
            "invalid_input"
        );
        assert!(core.get_request(&command.request_id).is_none());
    }
    assert_eq!(core.snapshot().revision, before.revision);
    block_primary(dir.path());
    assert_eq!(
        core.settle_rejected(
            command.clone(),
            Caller::Agent,
            CoreError::new("not_found", "任务已永久删除")
        )
        .unwrap_err()
        .code,
        "storage"
    );
    assert!(core.get_request(&command.request_id).is_none());
    assert_eq!(core.snapshot().revision, before.revision);
    assert_eq!(core.snapshot().data, before.data);
    restore_primary(dir.path());
    let receipt = core
        .settle_rejected(
            command.clone(),
            Caller::Agent,
            CoreError::new("not_found", "任务已永久删除"),
        )
        .unwrap();
    assert_eq!(core.get_request(&command.request_id), Some(receipt));
    assert_eq!(core.snapshot().data, before.data);
}

#[test]
fn settlement_reuses_normalized_fingerprint_and_never_overwrites_saved_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    let mut command = request(Operation::TaskCreate {
        input: json!({"title":" 原任务 ","tags":[" 工作 "]}),
    });
    let receipt = core.execute(command.clone(), Caller::Agent).unwrap();
    command.operation = Operation::TaskCreate {
        input: json!({"tags":["工作"],"title":"原任务"}),
    };
    let settled = core
        .settle_rejected(
            command,
            Caller::Agent,
            CoreError::new("conflict", "此错误不能覆盖已有成功回执"),
        )
        .unwrap();
    assert_eq!(settled, receipt);
    assert_eq!(core.snapshot().data.tasks.len(), 1);
    assert_eq!(core.snapshot().revision, receipt.revision);
}
