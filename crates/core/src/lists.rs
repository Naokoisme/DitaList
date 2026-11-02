use crate::validation;
use ditalist_contracts::*;
use std::collections::{BTreeMap, HashSet};

pub(crate) fn group(list: &TaskList) -> String {
    if let Some(parent) = &list.parent_list_id {
        format!("list:{parent}")
    } else if let Some(folder) = &list.folder_id {
        format!("folder:{folder}")
    } else {
        "lists".into()
    }
}

pub(crate) fn validate(data: &AppData) -> Result<(), CoreError> {
    let lists: BTreeMap<_, _> = data
        .lists
        .iter()
        .map(|list| (list.id.as_str(), list))
        .collect();
    for list in &data.lists {
        if list.id == "inbox"
            && (list.parent_list_id.is_some() || list.folder_id.is_some() || list.archived)
        {
            return Err(validation::invalid("收集箱不能归档、放入分组或作为子清单"));
        }
        if list.parent_list_id.is_some() && list.folder_id.is_some() {
            return Err(validation::invalid(
                "子清单通过父级继承分组，不能同时指定父清单与分组",
            ));
        }
        let mut cursor = list;
        let mut visited = HashSet::from([list.id.as_str()]);
        while let Some(parent) = &cursor.parent_list_id {
            validation::id(parent)?;
            if !visited.insert(parent.as_str()) {
                return Err(validation::invalid("清单不能移动到自身或下级清单内"));
            }
            if visited.len() > 3 {
                return Err(validation::invalid("清单最多三层，分组不计层级"));
            }
            cursor = lists
                .get(parent.as_str())
                .copied()
                .ok_or_else(|| CoreError::new("not_found", "父清单不存在"))?;
            if cursor.id == "inbox" || cursor.archived {
                return Err(validation::invalid("收集箱或归档清单不能作为父级"));
            }
        }
    }
    Ok(())
}

pub(crate) fn index(data: &AppData) -> Vec<ListInfo> {
    let lists: BTreeMap<_, _> = data
        .lists
        .iter()
        .map(|list| (list.id.as_str(), list))
        .collect();
    let mut subtrees: BTreeMap<String, Vec<String>> =
        lists.keys().map(|id| (id.to_string(), vec![])).collect();
    for id in lists.keys() {
        let mut cursor = *id;
        for _ in 0..3 {
            if let Some(ids) = subtrees.get_mut(cursor) {
                ids.push(id.to_string());
            }
            let Some(parent) = lists
                .get(cursor)
                .and_then(|list| list.parent_list_id.as_deref())
            else {
                break;
            };
            cursor = parent;
        }
    }
    data.lists
        .iter()
        .map(|list| {
            let mut lineage = vec![list];
            let mut cursor = list;
            while let Some(parent) = cursor
                .parent_list_id
                .as_deref()
                .and_then(|id| lists.get(id))
                .copied()
            {
                if lineage.len() >= 3 || lineage.iter().any(|ancestor| ancestor.id == parent.id) {
                    break;
                }
                lineage.push(parent);
                cursor = parent;
            }
            lineage.reverse();
            ListInfo {
                id: list.id.clone(),
                name: list.name.clone(),
                parent_id: list.parent_list_id.clone(),
                path: lineage.iter().map(|list| list.name.clone()).collect(),
                root_id: lineage[0].id.clone(),
                subtree_ids: subtrees.remove(&list.id).unwrap_or_default(),
                folder_id: lineage[0].folder_id.clone(),
            }
        })
        .collect()
}

pub(crate) fn reparent(
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
    let (parent, folder) = match target {
        ListMoveTarget::Group { folder_id } => {
            if folder_id
                .as_ref()
                .is_some_and(|id| !data.folders.iter().any(|folder| folder.id == *id))
            {
                return Err(CoreError::new("not_found", "分组不存在"));
            }
            (None, folder_id.clone())
        }
        ListMoveTarget::List { list_id, position } => {
            if !["before", "inside", "after"].contains(&position.as_str()) {
                return Err(validation::invalid("清单位置无效"));
            }
            let anchor = data
                .lists
                .iter()
                .find(|list| list.id == *list_id)
                .ok_or_else(|| CoreError::new("not_found", "目标清单不存在"))?;
            if anchor.id == id || anchor.id == "inbox" || anchor.archived {
                return Err(validation::invalid("不能移入收集箱、归档清单或自身"));
            }
            if position == "inside" {
                (Some(anchor.id.clone()), None)
            } else {
                (anchor.parent_list_id.clone(), anchor.folder_id.clone())
            }
        }
    };
    let source = data.lists.iter_mut().find(|list| list.id == id).unwrap();
    source.parent_list_id = parent;
    source.folder_id = folder;
    validate(data)
}
