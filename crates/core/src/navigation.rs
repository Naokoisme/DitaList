//! Navigation mutations ported from the explicitly handed-off 81f307e source.
use crate::{domain, validation};
use chrono::{DateTime, Utc};
use ditalist_contracts::*;
use regex::{Captures, Regex};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

fn list_group(folder_id: Option<&str>) -> String {
    folder_id
        .map(|id| format!("folder:{id}"))
        .unwrap_or_else(|| "lists".into())
}

fn list_groups(data: &AppData) -> BTreeMap<String, Vec<String>> {
    let mut folders: Vec<_> = data.folders.iter().collect();
    folders.sort_by(|a, b| a.sort_order.total_cmp(&b.sort_order));
    let mut groups = BTreeMap::from([("lists".into(), vec![])]);
    for folder in &folders {
        groups.insert(format!("folder:{}", folder.id), vec![]);
    }
    let mut lists: Vec<_> = data
        .lists
        .iter()
        .filter(|list| list.id != "inbox" && !list.archived)
        .collect();
    lists.sort_by(|a, b| a.sort_order.total_cmp(&b.sort_order));
    for list in lists {
        if let Some(group) = groups.get_mut(&list_group(list.folder_id.as_deref())) {
            group.push(format!("list:{}", list.id));
        }
    }
    groups.get_mut("lists").unwrap().extend(
        folders
            .into_iter()
            .map(|folder| format!("folder:{}", folder.id)),
    );
    groups
}

fn ordered(items: &[String], preferences: &NavigationPreferences, group: &str) -> Vec<String> {
    let order = unique(preferences.orders.get(group).into_iter().flatten().cloned());
    let positions: HashMap<_, _> = order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut indexed: Vec<_> = items.iter().enumerate().collect();
    indexed.sort_by_key(|(index, item)| {
        positions
            .get(item.as_str())
            .copied()
            .unwrap_or(order.len() + index)
    });
    indexed.into_iter().map(|(_, item)| item.clone()).collect()
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn sync_sort_orders(data: &mut AppData) {
    let mut list_positions = HashMap::new();
    let mut folder_positions = HashMap::new();
    for (group, items) in list_groups(data) {
        for (index, key) in ordered(&items, &data.settings.navigation, &group)
            .into_iter()
            .enumerate()
        {
            if let Some(id) = key.strip_prefix("list:") {
                list_positions.insert(id.to_owned(), index as f64);
            } else if let Some(id) = key.strip_prefix("folder:") {
                folder_positions.insert(id.to_owned(), index as f64);
            }
        }
    }
    for list in &mut data.lists {
        if let Some(position) = list_positions.get(&list.id) {
            list.sort_order = *position;
        }
    }
    for folder in &mut data.folders {
        if let Some(position) = folder_positions.get(&folder.id) {
            folder.sort_order = *position;
        }
    }
}

pub(crate) fn apply(
    data: &mut AppData,
    preferences: &NavigationPreferences,
    renames: &BTreeMap<String, String>,
    now: DateTime<Utc>,
) -> Result<(), CoreError> {
    validation::navigation(preferences)?;
    let mut existing = BTreeMap::new();
    for list in &data.lists {
        if list.id != "inbox" {
            existing.insert(format!("list:{}", list.id), list.name.clone());
        }
    }
    for folder in &data.folders {
        existing.insert(format!("folder:{}", folder.id), folder.name.clone());
    }
    for filter in &data.filters {
        existing.insert(format!("filter:{}", filter.id), filter.name.clone());
    }
    let tags: BTreeSet<_> = data
        .settings
        .custom_tags
        .iter()
        .chain(data.tasks.iter().flat_map(|task| task.tags.iter()))
        .cloned()
        .collect();
    for tag in &tags {
        existing.insert(format!("tag:{tag}"), tag.clone());
    }
    let mut names = BTreeMap::new();
    let mut tag_names = BTreeMap::new();
    for (key, raw) in renames {
        let original = existing.get(key).ok_or_else(|| {
            CoreError::new("conflict", "部分导航项目已不存在，请重新打开编辑导航")
        })?;
        let is_tag = key.starts_with("tag:");
        let name = if is_tag {
            raw.trim().trim_start_matches('#').trim()
        } else {
            raw.trim()
        };
        validation::text(name, original, 1, if is_tag { 200 } else { 500 })?;
        if name == original {
            continue;
        }
        names.insert(key.clone(), name.to_owned());
        if is_tag {
            tag_names.insert(original.clone(), name.to_owned());
        }
    }
    let mut final_tags = HashSet::new();
    for tag in &tags {
        let final_name = tag_names.get(tag).unwrap_or(tag);
        if !final_tags.insert(final_name) {
            return Err(CoreError::new(
                "conflict",
                format!("标签“{final_name}”已存在，请使用不同的名称"),
            ));
        }
    }
    let rename_tag = |tag: &String| tag_names.get(tag).unwrap_or(tag).clone();
    let rename_key = |key: &String| {
        key.strip_prefix("tag:")
            .map(|tag| {
                format!(
                    "tag:{}",
                    tag_names.get(tag).map(String::as_str).unwrap_or(tag)
                )
            })
            .unwrap_or_else(|| key.clone())
    };
    let navigation = NavigationPreferences {
        orders: preferences
            .orders
            .iter()
            .map(|(group, items)| (group.clone(), unique(items.iter().map(&rename_key))))
            .collect(),
        hidden: unique(preferences.hidden.iter().map(&rename_key)),
    };
    if !tag_names.is_empty() {
        for task in &mut data.tasks {
            if task.tags.iter().any(|tag| tag_names.contains_key(tag)) {
                task.tags = task.tags.iter().map(&rename_tag).collect();
                task.updated_at = domain::stamp(now);
            }
        }
    }
    let query_tag = Regex::new(r"(^|\s)#(\S+)").unwrap();
    for filter in &mut data.filters {
        if let Some(name) = names.get(&format!("filter:{}", filter.id)) {
            filter.name = name.clone();
        }
        if !tag_names.is_empty() {
            filter.query = query_tag
                .replace_all(&filter.query, |captures: &Captures| {
                    tag_names
                        .get(&captures[2])
                        .map(|name| format!("{}#{name}", &captures[1]))
                        .unwrap_or_else(|| captures[0].to_owned())
                })
                .into_owned();
        }
        validation::text(&filter.query, "更名后的筛选条件", 0, 10_000)?;
    }
    for list in &mut data.lists {
        if let Some(name) = names.get(&format!("list:{}", list.id)) {
            list.name = name.clone();
        }
    }
    for folder in &mut data.folders {
        if let Some(name) = names.get(&format!("folder:{}", folder.id)) {
            folder.name = name.clone();
        }
    }
    data.settings.default_view = rename_key(&data.settings.default_view);
    data.settings.custom_tags = data.settings.custom_tags.iter().map(rename_tag).collect();
    data.settings.navigation = navigation;
    sync_sort_orders(data);
    Ok(())
}

pub(crate) fn move_list(
    data: &mut AppData,
    id: &str,
    target: &ListMoveTarget,
) -> Result<(), CoreError> {
    let source = data
        .lists
        .iter()
        .find(|list| list.id == id)
        .ok_or_else(|| CoreError::new("not_found", "清单不存在"))?;
    if source.id == "inbox" || source.archived {
        return Err(validation::invalid("收集箱或归档清单不能移动"));
    }
    let destination_folder = match target {
        ListMoveTarget::Group { folder_id } => folder_id.clone(),
        ListMoveTarget::List { list_id, position } => {
            if !["before", "after"].contains(&position.as_str()) {
                return Err(validation::invalid("清单位置无效"));
            }
            let anchor = data
                .lists
                .iter()
                .find(|list| list.id == *list_id)
                .ok_or_else(|| CoreError::new("not_found", "目标清单不存在"))?;
            if anchor.id == id || anchor.id == "inbox" || anchor.archived {
                return Err(validation::invalid("目标清单不能用于排序"));
            }
            anchor.folder_id.clone()
        }
    };
    if let Some(folder) = &destination_folder
        && !data.folders.iter().any(|entry| entry.id == *folder)
    {
        return Err(validation::invalid("文件夹不存在"));
    }
    let source_group = list_group(source.folder_id.as_deref());
    let destination_group = list_group(destination_folder.as_deref());
    let groups = list_groups(data);
    let source_order = ordered(
        groups
            .get(&source_group)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &data.settings.navigation,
        &source_group,
    );
    let destination_order = if source_group == destination_group {
        source_order.clone()
    } else {
        ordered(
            groups
                .get(&destination_group)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            &data.settings.navigation,
            &destination_group,
        )
    };
    let key = format!("list:{id}");
    let mut destination: Vec<_> = destination_order
        .iter()
        .filter(|item| **item != key)
        .cloned()
        .collect();
    let index = match target {
        ListMoveTarget::Group { .. } => destination.len(),
        ListMoveTarget::List { list_id, position } => {
            destination
                .iter()
                .position(|item| *item == format!("list:{list_id}"))
                .ok_or_else(|| CoreError::new("conflict", "目标导航项目已变化"))?
                + usize::from(position == "after")
        }
    };
    destination.insert(index, key.clone());
    if source_group == destination_group && destination == destination_order {
        return Ok(());
    }
    domain::move_list(data, id, target)?;
    data.settings.navigation.orders.insert(
        source_group,
        source_order
            .into_iter()
            .filter(|item| *item != key)
            .collect(),
    );
    data.settings
        .navigation
        .orders
        .insert(destination_group, destination);
    sync_sort_orders(data);
    Ok(())
}

/// The list editor can change a folder without going through drag-and-drop.
pub(crate) fn upsert_list(data: &mut AppData, value: TaskList) {
    let previous = data.lists.iter().find(|list| list.id == value.id).cloned();
    let groups = list_groups(data);
    let old_preferences = data.settings.navigation.clone();
    let id = value.id.clone();
    let destination_group = list_group(value.folder_id.as_deref());
    let visible = !value.archived && value.id != "inbox";
    let moved = previous
        .as_ref()
        .is_some_and(|old| old.folder_id != value.folder_id);
    if let Some(index) = data.lists.iter().position(|list| list.id == value.id) {
        data.lists[index] = value;
    } else {
        data.lists.push(value);
    }
    if moved {
        let key = format!("list:{id}");
        let source_group = list_group(previous.as_ref().unwrap().folder_id.as_deref());
        let source_order = ordered(
            groups
                .get(&source_group)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            &old_preferences,
            &source_group,
        );
        data.settings.navigation.orders.insert(
            source_group,
            source_order
                .into_iter()
                .filter(|item| *item != key)
                .collect(),
        );
        if visible {
            let mut destination = ordered(
                groups
                    .get(&destination_group)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                &old_preferences,
                &destination_group,
            );
            destination.retain(|item| *item != key);
            destination.push(key);
            data.settings
                .navigation
                .orders
                .insert(destination_group, destination);
        }
    }
    sync_sort_orders(data);
}
