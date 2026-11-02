use ditalist_core::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
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
    fn list(&self, id: &str, parent: Option<&str>, folder: Option<&str>) {
        self.execute(Operation::CollectionUpsert { collection: "lists".into(), value: json!({"id":id,"name":id,"color":"#4772fa","parentListId":parent,"folderId":folder,"archived":false,"sortOrder":0}) });
    }
    fn folder(&self, id: &str) {
        self.execute(Operation::CollectionUpsert {
            collection: "folders".into(),
            value: json!({"id":id,"name":id,"sortOrder":0}),
        });
    }
    fn task(&self, id: &str, list: &str, tags: &[&str]) {
        self.execute(Operation::TaskCreate {
            input: json!({"id":id,"title":id,"listId":list,"tags":tags}),
        });
    }
    fn tag(&self, name: &str, parent: Option<&str>) -> String {
        self.execute(Operation::TagUpsert {
            name: name.into(),
            parent: parent.map(Into::into),
            original: None,
        })
        .result["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn rejected(&self, operation: Operation) {
        let before = self.core.snapshot();
        assert!(
            self.core
                .execute(request(operation), Caller::Local)
                .is_err()
        );
        assert_eq!(self.core.snapshot(), before);
    }
    fn navigation(&self, value: Value) {
        self.execute(Operation::NavigationUpdate {
            preferences: serde_json::from_value(value).unwrap(),
            renames: BTreeMap::new(),
        });
    }
}
fn request(operation: Operation) -> CoreCommand {
    CoreCommand {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
fn list_move(id: &str, target: &str, position: &str) -> Operation {
    Operation::ListMove {
        id: id.into(),
        target: ListMoveTarget::List {
            list_id: target.into(),
            position: position.into(),
        },
    }
}
fn tag_move(id: &str, target: &str, position: &str) -> Operation {
    Operation::TagMove {
        id: id.into(),
        target: TagMoveTarget::Tag {
            tag_id: target.into(),
            position: position.into(),
        },
    }
}
fn list(snapshot: &CoreSnapshot, id: &str) -> TaskList {
    snapshot
        .data
        .lists
        .iter()
        .find(|list| list.id == id)
        .unwrap()
        .clone()
}
fn list_info(snapshot: &CoreSnapshot, id: &str) -> ListInfo {
    snapshot
        .list_index
        .iter()
        .find(|list| list.id == id)
        .unwrap()
        .clone()
}

#[test]
fn dragging_tags_inside_moves_subtree_references_and_root_drop_restores_keys() {
    let f = Fixture::new();
    f.tag("学校", None);
    f.tag("数据结构", None);
    f.tag("作业", Some("数据结构"));
    f.task("task", "inbox", &["数据结构/作业"]);
    f.task("proposal", "inbox", &[]);
    f.core
        .execute(
            request(Operation::TaskUpdate {
                id: "proposal".into(),
                patch: json!({"tags":["数据结构/作业"]}),
                expected_version: None,
            }),
            Caller::Agent,
        )
        .unwrap();
    f.navigation(json!({"orders":{"tags":["tag:数据结构","tag:学校"],"tag:数据结构":["tag:数据结构/作业"]},"hidden":[]}));
    let receipt = f.execute(tag_move("数据结构", "学校", "inside"));
    assert_eq!(receipt.result["id"], "学校/数据结构");
    assert_eq!(
        receipt.result["mapping"],
        json!({"数据结构":"学校/数据结构","数据结构/作业":"学校/数据结构/作业"})
    );
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.data.tasks[0].tags, ["学校/数据结构/作业"]);
    assert_eq!(
        snapshot.approvals[0].patch["tags"],
        json!(["学校/数据结构/作业"])
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["tags"],
        ["tag:学校"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["tag:学校"],
        ["tag:学校/数据结构"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["tag:学校/数据结构"],
        ["tag:学校/数据结构/作业"]
    );
    let receipt = f.execute(Operation::TagMove {
        id: "学校/数据结构".into(),
        target: TagMoveTarget::Root,
    });
    assert_eq!(receipt.result["id"], "数据结构");
    assert_eq!(f.core.snapshot().data.tasks[0].tags, ["数据结构/作业"]);
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["tags"],
        ["tag:学校", "tag:数据结构"]
    );
}

#[test]
fn tag_edge_sorting_keeps_parent_and_cross_parent_edges_share_target_parent() {
    let f = Fixture::new();
    f.tag("学校", None);
    for label in ["语文", "数学", "英语"] {
        f.tag(label, Some("学校"));
    }
    f.navigation(json!({"orders":{"tag:学校":["tag:学校/语文","tag:学校/数学","tag:学校/英语"]},"hidden":[]}));
    let moved = f.execute(tag_move("学校/英语", "学校/语文", "before"));
    assert_eq!(moved.result["mapping"], json!({}));
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["tag:学校"],
        ["tag:学校/英语", "tag:学校/语文", "tag:学校/数学"]
    );
    assert_eq!(snapshot.data.settings.tag_parents["学校/英语"], "学校");
    f.execute(tag_move("学校/英语", "学校/数学", "after"));
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["tag:学校"],
        ["tag:学校/语文", "tag:学校/数学", "tag:学校/英语"]
    );
    f.tag("工作", None);
    f.tag("阅读", Some("工作"));
    f.execute(tag_move("工作/阅读", "学校/数学", "after"));
    assert_eq!(
        f.core.snapshot().data.settings.tag_parents["学校/阅读"],
        "学校"
    );
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["tag:学校"],
        [
            "tag:学校/语文",
            "tag:学校/数学",
            "tag:学校/阅读",
            "tag:学校/英语"
        ]
    );
}

#[test]
fn tag_drag_rejects_whole_tree_overflow_cycles_unknowns_and_agent_management() {
    let f = Fixture::new();
    f.tag("学校", None);
    f.tag("课程", Some("学校"));
    f.tag("作业", Some("学校/课程"));
    f.tag("工作", None);
    f.tag("项目", Some("工作"));
    for operation in [
        tag_move("工作", "学校/课程", "inside"),
        tag_move("学校", "学校/课程/作业", "inside"),
        tag_move("学校", "学校/课程", "before"),
        tag_move("学校", "学校", "after"),
        tag_move("学校", "不存在", "inside"),
        tag_move("不存在", "学校", "inside"),
        tag_move("工作", "学校", "unknown"),
    ] {
        f.rejected(operation);
    }
    assert_eq!(
        f.core
            .execute(request(tag_move("工作", "学校", "inside")), Caller::Agent)
            .unwrap_err()
            .code,
        "forbidden"
    );
}

#[test]
fn list_inside_uses_stable_ids_and_inherits_folder_for_the_entire_subtree() {
    let f = Fixture::new();
    f.folder("school-group");
    f.folder("work-group");
    f.list("学校", None, Some("school-group"));
    f.list("数据结构", None, Some("work-group"));
    f.list("作业", None, None);
    f.task("course-task", "数据结构", &[]);
    f.task("homework-task", "作业", &[]);
    let tasks = f.core.snapshot().data.tasks;
    f.execute(list_move("作业", "数据结构", "inside"));
    f.execute(list_move("数据结构", "学校", "inside"));
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.data.tasks, tasks);
    assert_eq!(
        list(&snapshot, "数据结构").parent_list_id,
        Some("学校".into())
    );
    assert_eq!(list(&snapshot, "数据结构").folder_id, None);
    assert_eq!(
        list_info(&snapshot, "作业").path,
        ["学校", "数据结构", "作业"]
    );
    assert_eq!(
        list_info(&snapshot, "作业").folder_id,
        Some("school-group".into())
    );
    assert_eq!(list_info(&snapshot, "学校").subtree_ids.len(), 3);
    assert_eq!(
        snapshot.data.settings.navigation.orders["list:学校"],
        ["list:数据结构"]
    );
    f.execute(Operation::ListMove {
        id: "学校".into(),
        target: ListMoveTarget::Group {
            folder_id: Some("work-group".into()),
        },
    });
    assert_eq!(
        list_info(&f.core.snapshot(), "作业").folder_id,
        Some("work-group".into())
    );
    assert_eq!(f.core.snapshot().data.tasks, tasks);
    f.execute(Operation::ListMove {
        id: "数据结构".into(),
        target: ListMoveTarget::Group { folder_id: None },
    });
    assert_eq!(
        list_info(&f.core.snapshot(), "作业").path,
        ["数据结构", "作业"]
    );
    assert_eq!(list_info(&f.core.snapshot(), "作业").folder_id, None);
}

#[test]
fn list_edge_sorting_moves_beside_the_target_without_nesting() {
    let f = Fixture::new();
    f.list("学校", None, None);
    for id in ["语文", "数学", "英语"] {
        f.list(id, Some("学校"), None);
    }
    f.navigation(json!({"orders":{"lists":["list:学校"],"list:学校":["list:语文","list:数学","list:英语"]},"hidden":[]}));
    f.execute(list_move("英语", "语文", "before"));
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["list:学校"],
        ["list:英语", "list:语文", "list:数学"]
    );
    assert_eq!(
        list(&f.core.snapshot(), "英语").parent_list_id,
        Some("学校".into())
    );
    f.execute(list_move("英语", "数学", "after"));
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["list:学校"],
        ["list:语文", "list:数学", "list:英语"]
    );
    f.list("读书", None, None);
    f.execute(list_move("读书", "数学", "before"));
    assert_eq!(
        list(&f.core.snapshot(), "读书").parent_list_id,
        Some("学校".into())
    );
    assert_eq!(
        f.core.snapshot().data.settings.navigation.orders["list:学校"],
        ["list:语文", "list:读书", "list:数学", "list:英语"]
    );
}

#[test]
fn list_drag_and_editor_share_cycle_depth_parent_and_archive_validation() {
    let f = Fixture::new();
    f.list("学校", None, None);
    f.list("课程", Some("学校"), None);
    f.list("作业", Some("课程"), None);
    f.list("工作", None, None);
    f.list("项目", Some("工作"), None);
    f.list("归档", None, None);
    let mut archived = serde_json::to_value(list(&f.core.snapshot(), "归档")).unwrap();
    archived["archived"] = json!(true);
    f.execute(Operation::CollectionUpsert {
        collection: "lists".into(),
        value: archived,
    });
    for operation in [
        list_move("工作", "课程", "inside"),
        list_move("学校", "作业", "inside"),
        list_move("学校", "课程", "before"),
        list_move("学校", "学校", "before"),
        list_move("学校", "inbox", "inside"),
        list_move("inbox", "学校", "inside"),
        list_move("学校", "归档", "inside"),
        list_move("归档", "学校", "inside"),
        list_move("学校", "unknown", "inside"),
        list_move("学校", "工作", "invalid"),
    ] {
        f.rejected(operation);
    }
    for (parent, folder) in [
        (Some("作业"), None),
        (Some("学校"), None),
        (Some("unknown"), None),
        (Some("归档"), None),
        (Some("inbox"), None),
        (Some("工作"), Some("invalid-folder")),
    ] {
        let mut entity = serde_json::to_value(list(&f.core.snapshot(), "学校")).unwrap();
        entity["parentListId"] = json!(parent);
        entity["folderId"] = json!(folder);
        f.rejected(Operation::CollectionUpsert {
            collection: "lists".into(),
            value: entity,
        });
    }
    assert_eq!(
        f.core
            .execute(request(list_move("工作", "学校", "inside")), Caller::Agent)
            .unwrap_err()
            .code,
        "forbidden"
    );
}

#[test]
fn deleting_or_archiving_a_parent_promotes_children_and_keeps_their_tasks_visible() {
    for archive in [false, true] {
        let f = Fixture::new();
        f.folder("f");
        f.list("before", None, Some("f"));
        f.list("parent", None, Some("f"));
        f.list("after", None, Some("f"));
        f.list("child-a", Some("parent"), None);
        f.list("child-b", Some("parent"), None);
        f.list("grandchild", Some("child-a"), None);
        f.task("direct", "parent", &[]);
        f.task("nested", "grandchild", &[]);
        f.navigation(json!({"orders":{"folder:f":["list:before","list:parent","list:after"],"list:parent":["list:child-b","list:child-a"]},"hidden":[]}));
        if archive {
            let mut entity = serde_json::to_value(list(&f.core.snapshot(), "parent")).unwrap();
            entity["archived"] = json!(true);
            f.execute(Operation::CollectionUpsert {
                collection: "lists".into(),
                value: entity,
            });
        } else {
            f.execute(Operation::CollectionDelete {
                collection: "lists".into(),
                id: "parent".into(),
            });
        }
        let snapshot = f.core.snapshot();
        assert_eq!(
            snapshot.data.settings.navigation.orders["folder:f"],
            ["list:before", "list:child-b", "list:child-a", "list:after"]
        );
        assert_eq!(list(&snapshot, "child-a").parent_list_id, None);
        assert_eq!(
            list_info(&snapshot, "grandchild").path,
            ["child-a", "grandchild"]
        );
        assert_eq!(
            list_info(&snapshot, "grandchild").folder_id,
            Some("f".into())
        );
        assert_eq!(
            snapshot
                .data
                .tasks
                .iter()
                .find(|task| task.id == "nested")
                .unwrap()
                .list_id,
            "grandchild"
        );
        assert_eq!(
            snapshot
                .data
                .tasks
                .iter()
                .find(|task| task.id == "direct")
                .unwrap()
                .list_id,
            if archive { "parent" } else { "inbox" }
        );
        assert!(
            !snapshot
                .data
                .settings
                .navigation
                .orders
                .contains_key("list:parent")
        );
    }
    let f = Fixture::new();
    f.list("root", None, None);
    f.list("middle", Some("root"), None);
    f.list("leaf", Some("middle"), None);
    f.execute(Operation::CollectionDelete {
        collection: "lists".into(),
        id: "middle".into(),
    });
    assert_eq!(
        list(&f.core.snapshot(), "leaf").parent_list_id,
        Some("root".into())
    );
}

#[test]
fn deleting_folder_preserves_nested_subtrees_and_root_mixed_order() {
    let f = Fixture::new();
    f.folder("f");
    f.list("before", None, None);
    f.list("after", None, None);
    f.list("parent", None, Some("f"));
    f.list("child", Some("parent"), None);
    f.navigation(json!({"orders":{"lists":["list:before","folder:f","list:after"],"folder:f":["list:parent"]},"hidden":[]}));
    f.execute(Operation::CollectionDelete {
        collection: "folders".into(),
        id: "f".into(),
    });
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["lists"],
        ["list:before", "list:parent", "list:after"]
    );
    assert_eq!(list_info(&snapshot, "child").path, ["parent", "child"]);
    assert_eq!(list_info(&snapshot, "child").folder_id, None);
}

#[test]
fn drag_hierarchies_round_trip_backup_restart_and_legacy_parent_defaults() {
    let f = Fixture::new();
    f.folder("f");
    f.list("学校", None, Some("f"));
    f.list("课程", None, None);
    f.execute(list_move("课程", "学校", "inside"));
    f.tag("学校", None);
    f.tag("课程", None);
    f.execute(tag_move("课程", "学校", "inside"));
    let snapshot = f.core.snapshot();
    let exported = f.core.export_backup().unwrap();
    let imported = Fixture::new();
    imported.execute(Operation::Import {
        text: exported.clone(),
    });
    assert_eq!(imported.core.snapshot().list_index, snapshot.list_index);
    assert_eq!(imported.core.snapshot().tag_index, snapshot.tag_index);
    let mut invalid: Value = serde_json::from_str(&exported).unwrap();
    invalid["data"]["lists"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|list| list["id"] == "学校")
        .unwrap()["parentListId"] = json!("课程");
    imported.rejected(Operation::Import {
        text: invalid.to_string(),
    });
    let Fixture { core, dir } = f;
    drop(core);
    let reopened = CoreService::open(dir.path()).unwrap();
    assert_eq!(reopened.snapshot().list_index, snapshot.list_index);
    let old = Fixture::new();
    old.list("旧清单", None, None);
    let mut backup: Value = serde_json::from_str(&old.core.export_backup().unwrap()).unwrap();
    for list in backup["data"]["lists"].as_array_mut().unwrap() {
        list.as_object_mut().unwrap().remove("parentListId");
    }
    let legacy = Fixture::new();
    legacy.execute(Operation::Import {
        text: backup.to_string(),
    });
    assert_eq!(
        list_info(&legacy.core.snapshot(), "旧清单").path,
        ["旧清单"]
    );
    assert_eq!(list(&legacy.core.snapshot(), "旧清单").parent_list_id, None);
}

#[test]
fn real_save_failure_rolls_back_drag_structure_order_mapping_and_receipt() {
    for is_tag in [false, true] {
        let f = Fixture::new();
        let operation = if is_tag {
            f.tag("学校", None);
            f.tag("课程", None);
            tag_move("课程", "学校", "inside")
        } else {
            f.list("学校", None, None);
            f.list("课程", None, None);
            list_move("课程", "学校", "inside")
        };
        let before = f.core.snapshot();
        let command = request(operation);
        let main = f.dir.path().join("database.rust.json");
        let held = f.dir.path().join("database.rust.held.json");
        std::fs::rename(&main, &held).unwrap();
        std::fs::create_dir(&main).unwrap();
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
        assert_eq!(f.core.execute(command, Caller::Local).unwrap(), receipt);
        if is_tag {
            assert_eq!(receipt.result["id"], "学校/课程");
        } else {
            assert_eq!(
                list(&f.core.snapshot(), "课程").parent_list_id,
                Some("学校".into())
            );
        }
    }
}
