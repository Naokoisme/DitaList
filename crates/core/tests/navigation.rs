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
    fn list(&self, id: &str, folder: Option<&str>) {
        self.execute(Operation::CollectionUpsert { collection: "lists".into(), value: json!({"id":id,"name":id,"color":"#4772fa","folderId":folder,"archived":false,"sortOrder":0}) });
    }
    fn folder(&self, id: &str) {
        self.execute(Operation::CollectionUpsert {
            collection: "folders".into(),
            value: json!({"id":id,"name":id,"sortOrder":0}),
        });
    }
    fn task(&self, id: &str, tags: &[&str]) {
        self.execute(Operation::TaskCreate {
            input: json!({"id":id,"title":id,"tags":tags}),
        });
    }
    fn filter(&self, id: &str, query: &str) {
        self.execute(Operation::CollectionUpsert {
            collection: "filters".into(),
            value: json!({"id":id,"name":id,"query":query,"color":"#4772fa"}),
        });
    }
}
fn request(operation: Operation) -> CoreCommand {
    CoreCommand {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
fn preferences(value: Value) -> NavigationPreferences {
    serde_json::from_value(value).unwrap()
}
fn rename(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[test]
fn atomic_navigation_renames_swap_tags_and_update_only_complete_references() {
    let f = Fixture::new();
    f.folder("f");
    f.list("a", None);
    f.task("task", &["工作", "生活"]);
    f.task("trashed", &["工作"]);
    f.execute(Operation::TaskTrash {
        id: "trashed".into(),
    });
    f.filter("filter", "今天 #工作 #工作台 #生活 \t#工作 foo#工作 #工作,");
    f.execute(Operation::SettingsUpdate {
        patch: json!({"customTags":["工作","生活"],"defaultView":"tag:工作"}),
    });
    let revision = f.core.snapshot().revision;
    let command = request(Operation::NavigationUpdate {
        preferences: preferences(
            json!({"orders":{"lists":["folder:f","list:a"],"tags":["tag:工作","tag:生活","tag:工作"],"sidebar":["inbox","today"]},"hidden":["tag:工作","rail:help","tag:工作"]}),
        ),
        renames: rename(&[
            ("tag:工作", " ##生活 "),
            ("tag:生活", "工作"),
            ("list:a", " 清单新名 "),
            ("folder:f", " 文件夹新名 "),
            ("filter:filter", " 新筛选 "),
        ]),
    });
    let first = f.core.execute(command.clone(), Caller::Local).unwrap();
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.revision, revision + 1);
    assert_eq!(
        snapshot
            .data
            .tasks
            .iter()
            .find(|task| task.id == "task")
            .unwrap()
            .tags,
        vec!["生活", "工作"]
    );
    let trashed = snapshot
        .data
        .tasks
        .iter()
        .find(|task| task.id == "trashed")
        .unwrap();
    assert_eq!(trashed.tags, vec!["生活"]);
    assert!(trashed.deleted_at.is_some());
    assert_eq!(
        snapshot.data.filters[0].query,
        "今天 #生活 #工作台 #工作 \t#生活 foo#工作 #工作,"
    );
    assert_eq!(snapshot.data.filters[0].name, "新筛选");
    assert_eq!(snapshot.data.settings.default_view, "tag:生活");
    assert_eq!(snapshot.data.settings.custom_tags, vec!["生活", "工作"]);
    assert_eq!(
        snapshot.data.settings.navigation.orders["tags"],
        vec!["tag:生活", "tag:工作"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.hidden,
        vec!["tag:生活", "rail:help"]
    );
    assert_eq!(snapshot.data.folders[0].name, "文件夹新名");
    assert_eq!(snapshot.data.folders[0].sort_order, 0.0);
    let list = snapshot
        .data
        .lists
        .iter()
        .find(|list| list.id == "a")
        .unwrap();
    assert_eq!(list.name, "清单新名");
    assert_eq!(list.sort_order, 1.0);
    assert_eq!(f.core.execute(command, Caller::Local).unwrap(), first);
    assert_eq!(f.core.snapshot().data, snapshot.data);
}

#[test]
fn tag_merge_conflicts_and_invalid_renames_do_not_partially_save_navigation() {
    let f = Fixture::new();
    f.list("a", None);
    f.task("task", &["工作", "生活"]);
    let before = f.core.snapshot();
    let command = Operation::NavigationUpdate {
        preferences: preferences(json!({"orders":{"lists":["list:a"]},"hidden":["today"]})),
        renames: rename(&[("list:a", "不应保存"), ("tag:工作", "生活")]),
    };
    assert_eq!(
        f.core
            .execute(request(command), Caller::Local)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(f.core.snapshot().data, before.data);
    assert_eq!(f.core.snapshot().revision, before.revision);
    for renames in [
        rename(&[("list:missing", "不存在")]),
        rename(&[("list:inbox", "不能更名")]),
        rename(&[("tag:工作", " ### ")]),
    ] {
        assert!(
            f.core
                .execute(
                    request(Operation::NavigationUpdate {
                        preferences: NavigationPreferences::default(),
                        renames
                    }),
                    Caller::Local
                )
                .is_err()
        );
        assert_eq!(f.core.snapshot().data, before.data);
    }
}

#[test]
fn standalone_tag_rename_uses_the_same_reference_rewrite() {
    let f = Fixture::new();
    f.task("task", &["旧标签"]);
    f.filter("filter", "#旧标签 #旧标签后缀\n#旧标签 文本#旧标签");
    f.execute(Operation::SettingsUpdate {
        patch: json!({"customTags":["旧标签"],"defaultView":"tag:旧标签"}),
    });
    f.execute(Operation::NavigationUpdate {
        preferences: preferences(json!({"orders":{"tags":["tag:旧标签"]},"hidden":["tag:旧标签"]})),
        renames: BTreeMap::new(),
    });
    f.execute(Operation::TagRename {
        from: "旧标签".into(),
        to: "新标签".into(),
    });
    let snapshot = f.core.snapshot();
    assert_eq!(snapshot.data.tasks[0].tags, vec!["新标签"]);
    assert_eq!(
        snapshot.data.filters[0].query,
        "#新标签 #旧标签后缀\n#新标签 文本#旧标签"
    );
    assert_eq!(snapshot.data.settings.default_view, "tag:新标签");
    assert_eq!(
        snapshot.data.settings.navigation.orders["tags"],
        vec!["tag:新标签"]
    );
    assert_eq!(snapshot.data.settings.navigation.hidden, vec!["tag:新标签"]);
}

fn mixed_root(f: &Fixture) {
    f.folder("f");
    f.folder("g");
    f.list("a", None);
    f.list("b", None);
    f.list("c", Some("f"));
    f.execute(Operation::NavigationUpdate{preferences:preferences(json!({"orders":{"lists":["list:a","folder:f","list:b","folder:g"],"folder:f":["list:c"]},"hidden":["list:a"]})),renames:BTreeMap::new()});
}

#[test]
fn list_drag_preserves_mixed_folder_root_order_and_cross_group_membership() {
    let f = Fixture::new();
    mixed_root(&f);
    f.execute(Operation::TaskCreate {
        input: json!({"id":"task","title":"保持任务","listId":"c","dueDate":"2026-10-30"}),
    });
    let before = f.core.snapshot().data.tasks.clone();
    f.execute(Operation::ListMove {
        id: "a".into(),
        target: ListMoveTarget::Group { folder_id: None },
    });
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["lists"],
        vec!["folder:f", "list:b", "folder:g", "list:a"]
    );
    assert_eq!(
        snapshot
            .data
            .folders
            .iter()
            .find(|folder| folder.id == "f")
            .unwrap()
            .sort_order,
        0.0
    );
    assert_eq!(
        snapshot
            .data
            .folders
            .iter()
            .find(|folder| folder.id == "g")
            .unwrap()
            .sort_order,
        2.0
    );
    assert_eq!(
        snapshot
            .data
            .lists
            .iter()
            .find(|list| list.id == "a")
            .unwrap()
            .sort_order,
        3.0
    );
    assert_eq!(snapshot.data.settings.navigation.hidden, vec!["list:a"]);
    f.execute(Operation::ListMove {
        id: "c".into(),
        target: ListMoveTarget::List {
            list_id: "b".into(),
            position: "before".into(),
        },
    });
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["lists"],
        vec!["folder:f", "list:c", "list:b", "folder:g", "list:a"]
    );
    assert!(snapshot.data.settings.navigation.orders["folder:f"].is_empty());
    assert_eq!(snapshot.data.tasks, before);
    assert_eq!(
        snapshot
            .data
            .lists
            .iter()
            .find(|list| list.id == "c")
            .unwrap()
            .folder_id,
        None
    );
}

#[test]
fn changing_list_folder_in_editor_updates_navigation_atomically() {
    let f = Fixture::new();
    mixed_root(&f);
    f.list("a", Some("f"));
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["lists"],
        vec!["folder:f", "list:b", "folder:g"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["folder:f"],
        vec!["list:c", "list:a"]
    );
    f.list("a", None);
    let snapshot = f.core.snapshot();
    assert_eq!(
        snapshot.data.settings.navigation.orders["lists"],
        vec!["folder:f", "list:b", "folder:g", "list:a"]
    );
    assert_eq!(
        snapshot.data.settings.navigation.orders["folder:f"],
        vec!["list:c"]
    );
    assert_eq!(
        snapshot
            .data
            .lists
            .iter()
            .find(|list| list.id == "a")
            .unwrap()
            .sort_order,
        3.0
    );
}

#[test]
fn navigation_persists_exports_and_old_snapshots_default_to_empty() {
    let f = Fixture::new();
    f.list("a", None);
    let preferences = preferences(
        json!({"orders":{"rail":["rail:calendar","rail:tasks"],"lists":["list:a"]},"hidden":["rail:help"]}),
    );
    f.execute(Operation::NavigationUpdate {
        preferences: preferences.clone(),
        renames: BTreeMap::new(),
    });
    let exported: Value = serde_json::from_str(&f.core.export_backup().unwrap()).unwrap();
    assert_eq!(
        exported["data"]["settings"]["navigation"],
        serde_json::to_value(&preferences).unwrap()
    );
    let Fixture { core, dir } = f;
    drop(core);
    let core = CoreService::open(dir.path()).unwrap();
    assert_eq!(core.snapshot().data.settings.navigation, preferences);
    drop(core);
    let path = dir.path().join("database.rust.json");
    let mut stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    stored["data"]["settings"]
        .as_object_mut()
        .unwrap()
        .remove("navigation");
    std::fs::write(path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let core = CoreService::open(dir.path()).unwrap();
    assert_eq!(
        core.snapshot().data.settings.navigation,
        NavigationPreferences::default()
    );
}

#[test]
fn validation_limits_and_expanded_filter_length_rollback_the_whole_command() {
    let f = Fixture::new();
    f.task("task", &["a"]);
    f.filter("filter", &vec!["#a"; 60].join(" "));
    let before = f.core.snapshot();
    let command = Operation::NavigationUpdate {
        preferences: NavigationPreferences::default(),
        renames: BTreeMap::from([("tag:a".into(), "长".repeat(200))]),
    };
    assert!(f.core.execute(request(command), Caller::Local).is_err());
    assert_eq!(f.core.snapshot().data, before.data);
    let mut invalid = NavigationPreferences::default();
    invalid.hidden.push("x".repeat(241));
    assert!(
        f.core
            .execute(
                request(Operation::NavigationUpdate {
                    preferences: invalid,
                    renames: BTreeMap::new()
                }),
                Caller::Local
            )
            .is_err()
    );
    assert_eq!(f.core.snapshot().revision, before.revision);
    assert_eq!(
        f.core
            .execute(
                request(Operation::NavigationUpdate {
                    preferences: NavigationPreferences::default(),
                    renames: BTreeMap::new()
                }),
                Caller::Agent
            )
            .unwrap_err()
            .code,
        "forbidden"
    );
}

#[test]
fn navigation_failure_does_not_publish_names_tags_or_order() {
    let f = Fixture::new();
    f.list("a", None);
    f.task("task", &["old"]);
    let before = f.core.snapshot();
    let main = f.dir.path().join("database.rust.json");
    let held = f.dir.path().join("database.rust.held.json");
    std::fs::rename(&main, &held).unwrap();
    std::fs::create_dir(&main).unwrap();
    let command = request(Operation::NavigationUpdate {
        preferences: preferences(json!({"orders":{"lists":["list:a"]},"hidden":["today"]})),
        renames: rename(&[("list:a", "new"), ("tag:old", "new")]),
    });
    assert_eq!(
        f.core
            .execute(command.clone(), Caller::Local)
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(f.core.snapshot().data, before.data);
    assert!(f.core.get_request(&command.request_id).is_none());
    std::fs::remove_dir(&main).unwrap();
    std::fs::rename(held, main).unwrap();
    f.core.execute(command, Caller::Local).unwrap();
    assert_eq!(f.core.snapshot().data.tasks[0].tags, vec!["new"]);
}
