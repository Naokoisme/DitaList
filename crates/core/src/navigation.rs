//! Navigation mutations ported from the explicitly handed-off 81f307e source.
use crate::{domain, lists, tags, validation};
use chrono::{DateTime, Utc};
use ditalist_contracts::*;
use std::collections::{BTreeMap, HashMap, HashSet};

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
    for list in &lists {
        groups.entry(format!("list:{}", list.id)).or_default();
    }
    for list in lists {
        if let Some(group) = groups.get_mut(&lists::group(list)) {
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

pub(crate) fn ordered(
    items: &[String],
    preferences: &NavigationPreferences,
    group: &str,
) -> Vec<String> {
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
) -> Result<BTreeMap<String, String>, CoreError> {
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
    let tags = tags::known(data);
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
    let tag_mapping = tags::rename(data, &tag_names, now)?;
    for filter in &mut data.filters {
        if let Some(name) = names.get(&format!("filter:{}", filter.id)) {
            filter.name = name.clone();
        }
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
    data.settings.navigation = tags::rewrite_navigation(preferences, &tag_mapping);
    sync_sort_orders(data);
    Ok(tag_mapping)
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
    let source_group = lists::group(source);
    let groups = list_groups(data);
    let preferences = data.settings.navigation.clone();
    let source_order = ordered(
        groups
            .get(&source_group)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &preferences,
        &source_group,
    );
    domain::move_list(data, id, target)?;
    let destination_group = lists::group(data.lists.iter().find(|list| list.id == id).unwrap());
    let key = format!("list:{id}");
    let mut destination = ordered(
        groups
            .get(&destination_group)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &preferences,
        &destination_group,
    );
    destination.retain(|item| item != &key);
    let insertion = match target {
        ListMoveTarget::List { list_id, position } if position != "inside" => {
            destination
                .iter()
                .position(|item| *item == format!("list:{list_id}"))
                .ok_or_else(|| CoreError::new("conflict", "目标导航项目已变化"))?
                + usize::from(position == "after")
        }
        _ => destination.len(),
    };
    destination.insert(insertion, key.clone());
    data.settings.navigation.orders.insert(
        source_group,
        source_order
            .into_iter()
            .filter(|item| item != &key)
            .collect(),
    );
    data.settings
        .navigation
        .orders
        .insert(destination_group, destination);
    sync_sort_orders(data);
    Ok(())
}

/// Removing or archiving a parent promotes its direct children in place.
fn promote_children(data: &mut AppData, id: &str) -> Result<(), CoreError> {
    let parent = data
        .lists
        .iter()
        .find(|list| list.id == id)
        .cloned()
        .ok_or_else(|| CoreError::new("not_found", "清单不存在"))?;
    let group = lists::group(&parent);
    let child_group = format!("list:{id}");
    let groups = list_groups(data);
    let children = ordered(
        groups
            .get(&child_group)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &data.settings.navigation,
        &child_group,
    );
    let mut order = ordered(
        groups.get(&group).map(Vec::as_slice).unwrap_or_default(),
        &data.settings.navigation,
        &group,
    );
    let key = format!("list:{id}");
    let position = order
        .iter()
        .position(|item| item == &key)
        .unwrap_or(order.len());
    order.retain(|item| item != &key && !children.contains(item));
    let position = position.min(order.len());
    order.splice(position..position, children);
    for child in &mut data.lists {
        if child.parent_list_id.as_deref() == Some(id) {
            child.parent_list_id = parent.parent_list_id.clone();
            child.folder_id = parent.folder_id.clone();
        }
    }
    data.settings.navigation.orders.insert(group, order);
    data.settings.navigation.orders.remove(&child_group);
    Ok(())
}

pub(crate) fn delete_list(data: &mut AppData, id: &str) -> Result<(), CoreError> {
    promote_children(data, id)?;
    data.lists.retain(|list| list.id != id);
    let key = format!("list:{id}");
    data.settings.navigation.hidden.retain(|item| item != &key);
    for items in data.settings.navigation.orders.values_mut() {
        items.retain(|item| item != &key);
    }
    if data.settings.default_view == key {
        data.settings.default_view = "all".into();
    }
    lists::validate(data)?;
    sync_sort_orders(data);
    Ok(())
}

pub(crate) fn delete_folder(data: &mut AppData, id: &str) {
    let group = format!("folder:{id}");
    let groups = list_groups(data);
    let promoted = ordered(
        groups.get(&group).map(Vec::as_slice).unwrap_or_default(),
        &data.settings.navigation,
        &group,
    );
    let mut root = ordered(
        groups.get("lists").map(Vec::as_slice).unwrap_or_default(),
        &data.settings.navigation,
        "lists",
    );
    let position = root
        .iter()
        .position(|item| item == &group)
        .unwrap_or(root.len());
    root.retain(|item| item != &group && !promoted.contains(item));
    let position = position.min(root.len());
    root.splice(position..position, promoted);
    data.folders.retain(|folder| folder.id != id);
    for list in &mut data.lists {
        if list.folder_id.as_deref() == Some(id) {
            list.folder_id = None;
        }
    }
    data.settings.navigation.orders.remove(&group);
    data.settings.navigation.orders.insert("lists".into(), root);
    data.settings
        .navigation
        .hidden
        .retain(|item| item != &group);
    sync_sort_orders(data);
}

/// The editor shares the same parent, depth and visibility invariants as dragging.
pub(crate) fn upsert_list(data: &mut AppData, value: TaskList) -> Result<(), CoreError> {
    let previous = data.lists.iter().find(|list| list.id == value.id).cloned();
    let moved = previous.as_ref().is_some_and(|old| {
        old.parent_list_id != value.parent_list_id || old.folder_id != value.folder_id
    });
    if moved
        && previous
            .as_ref()
            .is_some_and(|old| old.archived || old.id == "inbox")
    {
        return Err(validation::invalid("收集箱或归档清单不能移动"));
    }
    if value.archived && previous.as_ref().is_some_and(|old| !old.archived) {
        promote_children(data, &value.id)?;
    }
    let groups = list_groups(data);
    let preferences = data.settings.navigation.clone();
    let id = value.id.clone();
    let key = format!("list:{id}");
    let destination_group = lists::group(&value);
    let visible = !value.archived && id != "inbox";
    let visibility_changed = previous
        .as_ref()
        .is_some_and(|old| old.archived != value.archived);
    if let Some(index) = data.lists.iter().position(|list| list.id == id) {
        data.lists[index] = value;
    } else {
        data.lists.push(value);
    }
    lists::validate(data)?;
    if moved || visibility_changed {
        let source_group = lists::group(previous.as_ref().unwrap());
        let source_order = ordered(
            groups
                .get(&source_group)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            &preferences,
            &source_group,
        );
        data.settings.navigation.orders.insert(
            source_group.clone(),
            source_order
                .into_iter()
                .filter(|item| item != &key)
                .collect(),
        );
        if visible {
            let mut destination = ordered(
                groups
                    .get(&destination_group)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                &preferences,
                &destination_group,
            );
            destination.retain(|item| item != &key);
            destination.push(key);
            data.settings
                .navigation
                .orders
                .insert(destination_group, destination);
        }
    }
    sync_sort_orders(data);
    Ok(())
}
