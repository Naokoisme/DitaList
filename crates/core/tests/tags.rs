use ditalist_core::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use tempfile::TempDir;

struct Fixture {
    core: CoreService,
    dir: TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let core = CoreService::open(dir.path()).unwrap();
        Self { core, dir }
    }
    fn execute(&self, operation: Operation) -> CommandReceipt {
        self.core
            .execute(request(operation), Caller::Local)
            .unwrap()
    }
    fn tag(&self, name: &str, parent: Option<&str>) -> String {
        self.execute(upsert(name, parent, None)).result["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn task(&self, id: &str, tags: &[&str]) {
        self.execute(Operation::TaskCreate {
            input: json!({"id": id, "title": id, "tags":tags}),
        });
    }
    fn unchanged_after_rejection(&self, operation: Operation) {
        let before = self.core.snapshot();
        assert!(
            self.core
                .execute(request(operation), Caller::Local)
                .is_err()
        );
        assert_eq!(self.core.snapshot(), before);
    }
}
fn request(operation: Operation) -> CoreCommand {
    CoreCommand {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
fn upsert(name: &str, parent: Option<&str>, original: Option<&str>) -> Operation {
    Operation::TagUpsert {
        name: name.into(),
        parent: parent.map(Into::into),
        original: original.map(Into::into),
    }
}
fn node(snapshot: &CoreSnapshot, id: &str) -> TagInfo {
    snapshot
        .tag_index
        .iter()
        .find(|node| node.id == id)
        .unwrap()
        .clone()
}

#[test]
fn explicit_three_level_index_preserves_legacy_slashes_and_same_named_children() {
    let f = Fixture::new();
    f.task("legacy", &["学校/旧标签"]);
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    let politics = f.tag("形势与政策", Some(&school));
    let homework = f.tag("作业", Some(&course));
    let politics_homework = f.tag("作业", Some(&politics));
    f.task("both", &[&homework, &politics_homework]);
    let snapshot = f.core.snapshot();
    assert_eq!(
        node(&snapshot, &homework).path,
        ["学校", "数据结构", "作业"]
    );
    assert_eq!(node(&snapshot, &homework).root_id, school);
    assert_eq!(node(&snapshot, "学校/旧标签").path, ["学校/旧标签"]);
    assert_eq!(node(&snapshot, "学校/旧标签").parent_id, None);
    let school_node = node(&snapshot, &school);
    assert_eq!(school_node.subtree_ids.len(), 5);
    assert!(!school_node.subtree_ids.contains(&"学校/旧标签".into()));
    let school_tasks: Vec<_> = snapshot
        .data
        .tasks
        .iter()
        .filter(|task| {
            task.tags
                .iter()
                .any(|id| school_node.subtree_ids.contains(id))
        })
        .collect();
    assert_eq!(school_tasks.len(), 1);
    assert_eq!(school_tasks[0].tags, [homework, politics_homework]);
}

#[test]
fn fourth_level_cycles_collisions_and_subtree_depth_fail_atomically() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    let homework = f.tag("作业", Some(&course));
    let work = f.tag("工作", None);
    let project = f.tag("项目", Some(&work));
    f.unchanged_after_rejection(upsert("第四层", Some(&homework), None));
    f.unchanged_after_rejection(upsert("学校", Some(&course), Some(&school)));
    f.unchanged_after_rejection(upsert("数据结构", Some(&school), None));
    f.unchanged_after_rejection(upsert("学校", Some(&work), Some(&school)));
    f.unchanged_after_rejection(upsert("数据结构", Some(&project), Some(&course)));
    f.unchanged_after_rejection(upsert("不存在", Some("missing"), None));
    // A literal legacy root cannot silently become a child with the same key.
    f.tag("学校/字面标签", None);
    f.unchanged_after_rejection(upsert("字面标签", Some(&school), None));
    f.unchanged_after_rejection(Operation::SettingsUpdate {
        patch: json!({"tagParents":{"学校":"学校"}}),
    });
}

#[test]
fn subtree_rename_and_move_rewrite_tasks_filters_and_navigation_groups() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    let homework = f.tag("作业", Some(&course));
    let work = f.tag("工作", None);
    f.task("one", &[&course, &homework]);
    f.execute(Operation::SettingsUpdate {
        patch: json!({"defaultView":format!("tag:{homework}")}),
    });
    f.execute(Operation::CollectionUpsert { collection:"filters".into(), value:json!({"id":"f","name":"f","query":format!("#{school} #{course} #{homework} #学校/数据结构/作业后缀"),"color":"#4772fa"}) });
    f.execute(Operation::NavigationUpdate {
        preferences: serde_json::from_value(json!({"orders":{"tags":[format!("tag:{school}"),format!("tag:{work}")],format!("tag:{school}"):[format!("tag:{course}")],format!("tag:{course}"):[format!("tag:{homework}")]},"hidden":[format!("tag:{homework}")]})).unwrap(),
        renames: BTreeMap::new(),
    });
    f.execute(Operation::TagRename {
        from: school,
        to: "学习".into(),
    });
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.tasks[0].tags,
        ["学习/数据结构", "学习/数据结构/作业"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["tag:学习/数据结构"],
        ["tag:学习/数据结构/作业"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.hidden,
        ["tag:学习/数据结构/作业"]
    );
    assert_eq!(
        snapshot.data.settings.default_view,
        "tag:学习/数据结构/作业"
    );
    assert_eq!(
        snapshot.data.filters[0].query,
        "#学习 #学习/数据结构 #学习/数据结构/作业 #学校/数据结构/作业后缀"
    );
    let receipt = f.execute(upsert("数据结构", Some(&work), Some("学习/数据结构")));
    assert_eq!(receipt.result["id"], "工作/数据结构");
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.tasks[0].tags,
        ["工作/数据结构", "工作/数据结构/作业"]
    );
    assert_eq!(
        node(&snapshot, "工作/数据结构/作业").path,
        ["工作", "数据结构", "作业"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["tag:工作/数据结构"],
        ["tag:工作/数据结构/作业"]
    );
    assert_eq!(
        snapshot.data.settings.default_view,
        "tag:工作/数据结构/作业"
    );
    assert_eq!(
        snapshot.data.filters[0].query,
        "#学习 #工作/数据结构 #工作/数据结构/作业 #学校/数据结构/作业后缀"
    );
}

#[test]
fn navigation_batch_swaps_whole_subtrees_without_merging() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let school_work = f.tag("作业", Some(&school));
    let work = f.tag("工作", None);
    let work_item = f.tag("项目", Some(&work));
    f.task("school", &[&school_work]);
    f.task("work", &[&work_item]);
    f.execute(Operation::NavigationUpdate {
        preferences: NavigationPreferences::default(),
        renames: BTreeMap::from([
            ("tag:学校".into(), "工作".into()),
            ("tag:工作".into(), "学校".into()),
        ]),
    });
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.data.tasks[0].tags, ["工作/作业"]);
    assert_eq!(snapshot.data.tasks[1].tags, ["学校/项目"]);
    assert_eq!(node(&snapshot, "工作/作业").parent_id, Some("工作".into()));
    assert_eq!(node(&snapshot, "学校/项目").parent_id, Some("学校".into()));
}

#[test]
fn delete_keeps_tasks_and_cleans_pending_proposals_and_navigation() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    let homework = f.tag("作业", Some(&course));
    f.task("tagged", &[&homework]);
    f.task("proposal-target", &[]);
    let proposal = f
        .core
        .execute(
            request(Operation::TaskUpdate {
                id: "proposal-target".into(),
                patch: json!({"tags":[homework]}),
                expected_version: None,
            }),
            Caller::Agent,
        )
        .unwrap();
    let proposal_id = proposal.result["approvalId"].as_str().unwrap().to_owned();
    f.execute(Operation::SettingsUpdate {
        patch: json!({"defaultView":"tag:学校/数据结构"}),
    });
    f.execute(Operation::TagRename {
        from: school,
        to: "学习".into(),
    });
    assert_eq!(
        f.core.snapshot().approvals[0].patch["tags"],
        json!(["学习/数据结构/作业"])
    );
    f.execute(Operation::TagDelete {
        name: "学习/数据结构".into(),
    });
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.data.tasks.len(), 2);
    assert!(
        snapshot
            .data
            .tasks
            .iter()
            .all(|task| task.tags.is_empty() && task.deleted_at.is_none())
    );
    assert_eq!(snapshot.approvals[0].patch["tags"], json!([]));
    assert_eq!(snapshot.data.settings.default_view, "all");
    assert!(snapshot.data.settings.tag_parents.is_empty());
    assert_eq!(snapshot.data.settings.custom_tags, ["学习"]);
    f.execute(Operation::AgentApprove { id: proposal_id });
    assert!(f.core.snapshot().data.tasks[1].tags.is_empty());
    for operation in [
        upsert("禁止", None, None),
        Operation::TagRename {
            from: "学习".into(),
            to: "禁止".into(),
        },
        Operation::TagDelete {
            name: "学习".into(),
        },
    ] {
        assert_eq!(
            f.core
                .execute(request(operation), Caller::Agent)
                .unwrap_err()
                .code,
            "forbidden"
        );
    }
}

#[test]
fn hierarchy_round_trips_backup_restart_and_quick_add() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    let homework = f.tag("作业", Some(&course));
    f.execute(Operation::QuickAdd {
        text: format!("完成链表练习 #{homework}"),
        list_id: None,
        date: None,
        overrides: None,
    });
    let before = f.core.snapshot();
    assert_eq!(before.data.tasks[0].title, "完成链表练习");
    assert_eq!(before.data.tasks[0].tags, [homework]);
    let exported = f.core.export_backup().unwrap();
    let imported = Fixture::new();
    imported.execute(Operation::Import {
        text: exported.clone(),
    });
    assert_eq!(imported.core.snapshot().tag_index, before.tag_index);
    assert_eq!(imported.core.snapshot().data.tasks, before.data.tasks);
    let data = before.data.clone();
    drop(f.core);
    let reopened = CoreService::open(f.dir.path()).unwrap();
    assert_eq!(reopened.snapshot().data, data);
    assert_eq!(reopened.snapshot().tag_index, before.tag_index);
    let flat = Fixture::new();
    flat.tag("学校/数据结构", None);
    flat.unchanged_after_rejection(Operation::Import { text: exported });
    let old = Fixture::new();
    let mut old_backup: serde_json::Value =
        serde_json::from_str(&old.core.export_backup().unwrap()).unwrap();
    old_backup["data"]["settings"]
        .as_object_mut()
        .unwrap()
        .remove("tagParents");
    old_backup["data"]["settings"]["customTags"] = json!(["旧/标签"]);
    old.execute(Operation::Import {
        text: old_backup.to_string(),
    });
    assert_eq!(node(&old.core.snapshot(), "旧/标签").path, ["旧/标签"]);
}

#[test]
fn storage_failure_does_not_publish_subtree_rekey_and_retry_keeps_request() {
    let f = Fixture::new();
    let school = f.tag("学校", None);
    let course = f.tag("数据结构", Some(&school));
    f.task("task", &[&course]);
    let before = f.core.snapshot();
    let main = f.dir.path().join("database.rust.json");
    let held = f.dir.path().join("database.rust.held.json");
    std::fs::rename(&main, &held).unwrap();
    std::fs::create_dir(&main).unwrap();
    let command = request(upsert("学习", None, Some(&school)));
    assert_eq!(
        f.core
            .execute(command.clone(), Caller::Local)
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(f.core.snapshot(), before);
    assert!(f.core.get_request(&command.request_id).is_none());
    std::fs::remove_dir(&main).unwrap();
    std::fs::rename(held, main).unwrap();
    let receipt = f.core.execute(command.clone(), Caller::Local).unwrap();
    assert_eq!(receipt.result["id"], "学习");
    assert_eq!(f.core.snapshot().data.tasks[0].tags, ["学习/数据结构"]);
    assert_eq!(f.core.execute(command, Caller::Local).unwrap(), receipt);
    let ids: BTreeSet<_> = f
        .core
        .snapshot()
        .tag_index
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert_eq!(ids, BTreeSet::from(["学习".into(), "学习/数据结构".into()]));
}

#[test]
fn task_only_parent_becomes_durable_before_original_assignment_is_removed() {
    let f = Fixture::new();
    f.task("implicit-parent", &["学校"]);
    assert!(f.core.snapshot().data.settings.custom_tags.is_empty());
    let course = f.tag("数据结构", Some("学校"));
    let homework = f.tag("作业", Some(&course));
    f.execute(Operation::TaskUpdate {
        id: "implicit-parent".into(),
        patch: json!({"tags": []}),
        expected_version: None,
    });
    f.execute(Operation::TaskTrash {
        id: "implicit-parent".into(),
    });
    f.execute(Operation::TaskPurge {
        id: "implicit-parent".into(),
        confirmed: true,
    });
    let snapshot = f.core.snapshot();
    assert!(snapshot.data.tasks.is_empty());
    assert!(snapshot.data.settings.custom_tags.contains(&"学校".into()));
    assert_eq!(
        node(&snapshot, &homework).path,
        ["学校", "数据结构", "作业"]
    );
    f.unchanged_after_rejection(upsert("不存在", Some("missing"), None));
}
