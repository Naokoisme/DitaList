use crate::{domain, validation};
use chrono::{DateTime, Utc};
use ditalist_contracts::*;
use regex::{Captures, Regex};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(crate) fn known(data: &AppData) -> BTreeSet<String> {
    data.settings
        .custom_tags
        .iter()
        .chain(data.tasks.iter().flat_map(|task| task.tags.iter()))
        .cloned()
        .collect()
}

pub(crate) fn name<'a>(id: &'a str, parents: &BTreeMap<String, String>) -> &'a str {
    parents
        .get(id)
        .and_then(|parent| id.strip_prefix(parent))
        .and_then(|suffix| suffix.strip_prefix('/'))
        .unwrap_or(id)
}

fn clean_name(raw: &str) -> Result<String, CoreError> {
    let name = raw.trim().trim_start_matches('#').trim();
    validation::text(name, "标签名称", 1, 200)?;
    Ok(name.into())
}

pub(crate) fn validate(data: &AppData) -> Result<(), CoreError> {
    let parents = &data.settings.tag_parents;
    if parents.len() > 500 {
        return Err(validation::invalid("子标签过多"));
    }
    let known = known(data);
    for (id, parent) in parents {
        if !known.contains(id) || !known.contains(parent) {
            return Err(validation::invalid("标签引用了不存在的父标签"));
        }
        validation::text(id, "标签完整路径", 1, 200)?;
        if !id.starts_with(&format!("{parent}/")) || name(id, parents).trim().is_empty() {
            return Err(validation::invalid("子标签路径与父标签不一致"));
        }
        let mut cursor = id.as_str();
        let mut visited = HashSet::new();
        while let Some(parent) = parents.get(cursor) {
            if !visited.insert(cursor) {
                return Err(validation::invalid("标签不能循环引用父级"));
            }
            if visited.len() >= 3 {
                return Err(validation::invalid("标签最多三层，主标签计第一层"));
            }
            cursor = parent;
        }
    }
    Ok(())
}

pub(crate) fn index(data: &AppData) -> Vec<TagInfo> {
    let parents = &data.settings.tag_parents;
    let ids = known(data);
    let mut subtrees: BTreeMap<String, Vec<String>> =
        ids.iter().map(|id| (id.clone(), vec![])).collect();
    for id in &ids {
        let mut cursor = id.as_str();
        for _ in 0..3 {
            if let Some(subtree) = subtrees.get_mut(cursor) {
                subtree.push(id.clone());
            }
            let Some(parent) = parents.get(cursor) else {
                break;
            };
            cursor = parent;
        }
    }
    let result: Vec<TagInfo> = ids
        .iter()
        .map(|id| {
            let mut lineage = vec![id.as_str()];
            let mut cursor = id.as_str();
            while let Some(parent) = parents.get(cursor) {
                if lineage.contains(&parent.as_str()) || lineage.len() >= 3 {
                    break;
                }
                lineage.push(parent);
                cursor = parent;
            }
            lineage.reverse();
            TagInfo {
                id: id.clone(),
                name: name(id, parents).into(),
                parent_id: parents.get(id).cloned(),
                path: lineage.iter().map(|id| name(id, parents).into()).collect(),
                root_id: lineage[0].into(),
                subtree_ids: subtrees.remove(id).unwrap_or_default(),
            }
        })
        .collect();
    result
}

pub(crate) fn rewrite_key(key: &str, mapping: &BTreeMap<String, String>) -> String {
    for prefix in ["tag:", "tags:"] {
        if let Some(id) = key.strip_prefix(prefix) {
            return format!(
                "{prefix}{}",
                mapping.get(id).map(String::as_str).unwrap_or(id)
            );
        }
    }
    key.into()
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub(crate) fn rewrite_navigation(
    preferences: &NavigationPreferences,
    mapping: &BTreeMap<String, String>,
) -> NavigationPreferences {
    NavigationPreferences {
        orders: preferences
            .orders
            .iter()
            .map(|(group, items)| {
                (
                    rewrite_key(group, mapping),
                    unique(items.iter().map(|key| rewrite_key(key, mapping))),
                )
            })
            .collect(),
        hidden: unique(
            preferences
                .hidden
                .iter()
                .map(|key| rewrite_key(key, mapping)),
        ),
    }
}

fn rewrite_data(
    data: &mut AppData,
    mapping: &BTreeMap<String, String>,
    now: DateTime<Utc>,
) -> Result<(), CoreError> {
    for task in &mut data.tasks {
        if task.tags.iter().any(|id| mapping.contains_key(id)) {
            task.tags = unique(
                task.tags
                    .iter()
                    .map(|id| mapping.get(id).unwrap_or(id).clone()),
            );
            task.updated_at = domain::stamp(now);
        }
    }
    data.settings.custom_tags = unique(
        data.settings
            .custom_tags
            .iter()
            .map(|id| mapping.get(id).unwrap_or(id).clone()),
    );
    data.settings.default_view = rewrite_key(&data.settings.default_view, mapping);
    data.settings.navigation = rewrite_navigation(&data.settings.navigation, mapping);
    let query_tag = Regex::new(r"(^|\s)#(\S+)").unwrap();
    for filter in &mut data.filters {
        filter.query = query_tag
            .replace_all(&filter.query, |captures: &Captures| {
                mapping
                    .get(&captures[2])
                    .map(|name| format!("{}#{name}", &captures[1]))
                    .unwrap_or_else(|| captures[0].to_owned())
            })
            .into_owned();
        validation::text(&filter.query, "更名后的筛选条件", 0, 10_000)?;
    }
    Ok(())
}

/// Builds every new key from the explicit graph, preserving simultaneous swaps.
fn remap(
    data: &mut AppData,
    names: &BTreeMap<String, String>,
    moved: Option<(&str, Option<&str>)>,
    now: DateTime<Utc>,
) -> Result<BTreeMap<String, String>, CoreError> {
    let known = known(data);
    let mut parents = data.settings.tag_parents.clone();
    if let Some((id, parent)) = moved {
        if let Some(parent) = parent {
            parents.insert(id.into(), parent.into());
        } else {
            parents.remove(id);
        }
    }
    fn resolve(
        id: &str,
        original_parents: &BTreeMap<String, String>,
        parents: &BTreeMap<String, String>,
        names: &BTreeMap<String, String>,
        resolved: &mut BTreeMap<String, String>,
        visiting: &mut HashSet<String>,
    ) -> Result<String, CoreError> {
        if let Some(value) = resolved.get(id) {
            return Ok(value.clone());
        }
        if !visiting.insert(id.into()) {
            return Err(validation::invalid("标签不能移动到自身或下级标签内"));
        }
        if visiting.len() > 3 {
            return Err(validation::invalid("移动后标签超过三层"));
        }
        let label = names
            .get(id)
            .map(String::as_str)
            .unwrap_or_else(|| name(id, original_parents));
        let value = if let Some(parent) = parents.get(id) {
            format!(
                "{}/{}",
                resolve(parent, original_parents, parents, names, resolved, visiting)?,
                label
            )
        } else {
            label.into()
        };
        validation::text(&value, "标签完整路径", 1, 200)?;
        visiting.remove(id);
        resolved.insert(id.into(), value.clone());
        Ok(value)
    }
    let mut resolved = BTreeMap::new();
    for id in &known {
        resolve(
            id,
            &data.settings.tag_parents,
            &parents,
            names,
            &mut resolved,
            &mut HashSet::new(),
        )?;
    }
    let mut final_ids = HashSet::new();
    for id in resolved.values() {
        if !final_ids.insert(id) {
            return Err(CoreError::new(
                "conflict",
                format!("标签“{id}”已存在，请使用不同的名称"),
            ));
        }
    }
    let next_parents: BTreeMap<_, _> = parents
        .iter()
        .map(|(id, parent)| (resolved[id].clone(), resolved[parent].clone()))
        .collect();
    let mapping: BTreeMap<_, _> = resolved.into_iter().filter(|(id, new)| id != new).collect();
    rewrite_data(data, &mapping, now)?;
    data.settings.tag_parents = next_parents;
    validate(data)?;
    Ok(mapping)
}

pub(crate) fn rename(
    data: &mut AppData,
    names: &BTreeMap<String, String>,
    now: DateTime<Utc>,
) -> Result<BTreeMap<String, String>, CoreError> {
    let known = known(data);
    let names: BTreeMap<_, _> = names
        .iter()
        .map(|(id, raw)| {
            if !known.contains(id) {
                return Err(CoreError::new(
                    "conflict",
                    "标签已不存在，请重新打开标签设置",
                ));
            }
            Ok((id.clone(), clean_name(raw)?))
        })
        .collect::<Result<_, CoreError>>()?;
    remap(data, &names, None, now)
}

pub(crate) fn upsert(
    data: &mut AppData,
    raw: &str,
    parent: Option<&str>,
    original: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(String, BTreeMap<String, String>), CoreError> {
    let name = clean_name(raw)?;
    let known = known(data);
    if parent.is_some_and(|parent| !known.contains(parent)) {
        return Err(CoreError::new("not_found", "父标签已不存在"));
    }
    if let Some(original) = original {
        if !known.contains(original) {
            return Err(CoreError::new("not_found", "标签已不存在"));
        }
        let mapping = remap(
            data,
            &BTreeMap::from([(original.into(), name)]),
            Some((original, parent)),
            now,
        )?;
        let id = mapping
            .get(original)
            .cloned()
            .unwrap_or_else(|| original.into());
        if !data.settings.custom_tags.contains(&id) {
            data.settings.custom_tags.push(id.clone());
        }
        register_hierarchy(data);
        Ok((id, mapping))
    } else {
        let id = parent
            .map(|parent| format!("{parent}/{name}"))
            .unwrap_or(name);
        validation::text(&id, "标签完整路径", 1, 200)?;
        if known.contains(&id) {
            return Err(CoreError::new("conflict", "同一父级下已存在该标签"));
        }
        data.settings.custom_tags.push(id.clone());
        if let Some(parent) = parent {
            data.settings.tag_parents.insert(id.clone(), parent.into());
        }
        register_hierarchy(data);
        validate(data)?;
        Ok((id, BTreeMap::new()))
    }
}

fn register_hierarchy(data: &mut AppData) {
    // A parent discovered from a task becomes a durable tag when children are added.
    data.settings.custom_tags = unique(
        data.settings
            .custom_tags
            .iter()
            .chain(data.settings.tag_parents.keys())
            .chain(data.settings.tag_parents.values())
            .cloned(),
    );
}

pub(crate) fn delete(data: &mut AppData, id: &str, now: DateTime<Utc>) -> BTreeSet<String> {
    let removed: BTreeSet<_> = index(data)
        .into_iter()
        .find(|info| info.id == id)
        .map(|info| info.subtree_ids.into_iter().collect())
        .unwrap_or_else(|| BTreeSet::from([id.into()]));
    data.settings
        .custom_tags
        .retain(|tag| !removed.contains(tag));
    data.settings
        .tag_parents
        .retain(|tag, parent| !removed.contains(tag) && !removed.contains(parent));
    for task in &mut data.tasks {
        if task.tags.iter().any(|tag| removed.contains(tag)) {
            task.tags.retain(|tag| !removed.contains(tag));
            task.updated_at = domain::stamp(now);
        }
    }
    let removed_key = |key: &str| {
        key.strip_prefix("tag:")
            .or_else(|| key.strip_prefix("tags:"))
            .is_some_and(|id| removed.contains(id))
    };
    if removed_key(&data.settings.default_view) {
        data.settings.default_view = "all".into();
    }
    data.settings
        .navigation
        .hidden
        .retain(|key| !removed_key(key));
    data.settings.navigation.orders.retain(|group, items| {
        items.retain(|key| !removed_key(key));
        !removed_key(group)
    });
    removed
}

pub(crate) fn merge(data: &mut AppData, incoming: &AppData) -> Result<(), CoreError> {
    let existing = known(data);
    for id in known(incoming) {
        if existing.contains(&id)
            && data.settings.tag_parents.get(&id) != incoming.settings.tag_parents.get(&id)
        {
            return Err(CoreError::new(
                "conflict",
                format!("导入标签“{id}”的父级与本机不同，请先调整标签名称"),
            ));
        }
    }
    data.settings.custom_tags = unique(
        data.settings
            .custom_tags
            .iter()
            .chain(incoming.settings.custom_tags.iter())
            .chain(incoming.settings.tag_parents.keys())
            .chain(incoming.settings.tag_parents.values())
            .cloned(),
    );
    data.settings
        .tag_parents
        .extend(incoming.settings.tag_parents.clone());
    Ok(())
}
