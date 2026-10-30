use crate::{domain, validation};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use ditalist_contracts::*;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(crate) const MAX_IMPORT_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct Imported {
    pub data: AppData,
    pub approvals: Vec<Approval>,
    pub warnings: Vec<String>,
    pub entity_versions: BTreeMap<String, u64>,
}

pub(crate) fn parse(text: &str, now: DateTime<Utc>) -> Result<Imported, CoreError> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err(validation::invalid("备份文件超过 32 MB，请拆分后再导入"));
    }
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.starts_with('{') {
        let value: Value = serde_json::from_str(text)
            .map_err(|e| validation::invalid(format!("备份 JSON 无法解析，现有数据未改动：{e}")))?;
        let raw = value.get("data").cloned().unwrap_or_else(|| value.clone());
        let data = validation::decode_legacy(raw)?;
        let mut warnings = vec![];
        let approvals = if let Some(ext) = value.get("rustExtensions") {
            if ext.get("version").and_then(Value::as_u64) != Some(1) {
                return Err(CoreError::new(
                    "unsupported_format",
                    "不支持的 Rust 备份扩展版本",
                ));
            }
            let parsed: Vec<Approval> =
                serde_json::from_value(ext.get("approvals").cloned().unwrap_or(json!([])))
                    .map_err(|e| validation::invalid(format!("备份审核申请格式错误：{e}")))?;
            for approval in &parsed {
                validation::id(&approval.id)?;
                validation::id(&approval.task_id)?;
                validation::timestamp(&approval.created_at)?;
                if approval.status != "pending" {
                    return Err(validation::invalid("兼容备份只能携带待审核申请"));
                }
                let mut target = json!({});
                validation::patch_known(&mut target, &approval.patch, domain::TASK_EDIT_FIELDS)?;
            }
            parsed
        } else {
            vec![]
        };
        if !approvals.is_empty() {
            warnings.push("已导入待审核修改；批准时会重新核对目标任务版本".into());
        }
        let entity_versions = value
            .get("rustExtensions")
            .and_then(|ext| ext.get("entityVersions"))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| validation::invalid(format!("备份实体版本格式错误：{e}")))?
            .unwrap_or_default();
        Ok(Imported {
            data,
            approvals,
            warnings,
            entity_versions,
        })
    } else {
        csv(text, now)
    }
}

/// Preserve the old UTF-16 FNV identifiers so importing a CSV in either host is idempotent.
fn stable_id(text: &str) -> String {
    let mut hash = 14_695_981_039_346_656_037u64;
    for value in text.encode_utf16() {
        hash ^= u64::from(value);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    format!("import-{hash:x}")
}

pub(crate) fn csv_rows(text: &str) -> Result<Vec<Vec<String>>, CoreError> {
    let mut rows = vec![];
    let mut row = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut after_quote = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                    after_quote = true;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() && !after_quote {
            quoted = true;
        } else if [',', '\n', '\r'].contains(&c) {
            row.push(std::mem::take(&mut field));
            after_quote = false;
            if c != ',' {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                if row.iter().any(|field| !field.trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                }
                row.clear();
            }
        } else if after_quote && !c.is_whitespace() {
            return Err(validation::invalid("CSV 引号结束后出现无效字符"));
        } else if !after_quote {
            field.push(c);
        }
    }
    if quoted {
        return Err(validation::invalid("CSV 存在未闭合的引号"));
    }
    row.push(field);
    if row.iter().any(|value| !value.trim().is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}

fn parse_timestamp(text: &str) -> Option<DateTime<Utc>> {
    if let Ok(value) = DateTime::parse_from_rfc3339(text) {
        return Some(value.with_timezone(&Utc));
    }
    if let Ok(value) = DateTime::parse_from_rfc2822(text) {
        return Some(value.with_timezone(&Utc));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%m/%d/%Y %H:%M:%S",
    ] {
        if let Ok(value) = NaiveDateTime::parse_from_str(text, format) {
            return Local
                .from_local_datetime(&value)
                .earliest()
                .map(|dt| dt.with_timezone(&Utc));
        }
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y"] {
        if let Ok(value) = NaiveDate::parse_from_str(text, format) {
            return Local
                .from_local_datetime(&value.and_hms_opt(0, 0, 0)?)
                .earliest()
                .map(|dt| dt.with_timezone(&Utc));
        }
    }
    None
}

fn import_date(
    text: &str,
    row: usize,
    warnings: &mut Vec<String>,
) -> (Option<String>, Option<String>) {
    if text.is_empty() {
        return (None, None);
    }
    if let Ok(day) = validation::date(text) {
        return (Some(domain::date_text(day)), None);
    }
    if let Some(value) = parse_timestamp(text) {
        let local = value.with_timezone(&Local);
        return (
            Some(local.format("%Y-%m-%d").to_string()),
            Some(local.format("%H:%M").to_string()),
        );
    }
    warnings.push(format!(
        "第 {} 行日期无效或无法识别，已保留任务但省略该日期",
        row + 1
    ));
    (None, None)
}

fn csv(text: &str, now: DateTime<Utc>) -> Result<Imported, CoreError> {
    let rows = csv_rows(text)?;
    let header_index = rows
        .iter()
        .position(|row| {
            row.iter().any(|value| {
                ["title", "task name", "任务名称", "任务标题", "标题"]
                    .contains(&value.trim().to_lowercase().as_str())
            })
        })
        .ok_or_else(|| {
            validation::invalid("CSV 中没有找到任务标题列，请使用滴答清单导出的备份 CSV")
        })?;
    let headers: Vec<_> = rows[header_index]
        .iter()
        .map(|v| v.trim().to_lowercase())
        .collect();
    let mut data = domain::empty_data();
    let mut warnings = vec![];
    let interval = Regex::new(r"INTERVAL=(\d+)").unwrap();
    for (index, row) in rows.iter().enumerate().skip(header_index + 1) {
        let get = |names: &[&str]| -> &str {
            headers
                .iter()
                .position(|header| names.contains(&header.as_str()))
                .and_then(|position| row.get(position))
                .map(|v| v.trim())
                .unwrap_or("")
        };
        let title = get(&["title", "task name", "任务名称", "任务标题", "标题"]);
        if title.is_empty() {
            continue;
        }
        let name = get(&["list name", "list", "清单名称", "清单"]);
        let name = if name.is_empty() { "收集箱" } else { name };
        let list_id = if let Some(list) = data.lists.iter().find(|list| list.name == name) {
            list.id.clone()
        } else {
            let id = stable_id(&format!("list:{name}"));
            data.lists.push(TaskList {
                id: id.clone(),
                name: name.into(),
                color: "#4772FA".into(),
                folder_id: None,
                archived: false,
                sort_order: data.lists.len() as f64,
            });
            id
        };
        let due = import_date(
            get(&["due date", "due", "截止日期", "日期"]),
            index,
            &mut warnings,
        );
        let start = import_date(get(&["start date", "开始日期"]), index, &mut warnings);
        let completion = parse_timestamp(get(&["completed time", "completed date", "完成时间"]));
        let created = parse_timestamp(get(&["created time", "created date", "创建时间"]));
        let status = get(&["status", "状态"]).to_lowercase();
        let repeat = get(&["repeat", "repeat rule", "重复"]);
        let upper_repeat = repeat.to_uppercase();
        let priority = get(&["priority", "优先级"]).to_lowercase();
        let priority = if priority == "5" || priority.contains("high") || priority.contains('高') {
            1
        } else if priority == "3" || priority.contains("medium") || priority.contains('中') {
            2
        } else if priority == "1" || priority.contains("low") || priority.contains('低') {
            3
        } else {
            0
        };
        let mut rule = if upper_repeat.contains("FREQ=DAILY") || repeat.contains("每天") {
            "daily"
        } else if upper_repeat.contains("FREQ=WEEKLY") || repeat.contains("每周") {
            "weekly"
        } else if upper_repeat.contains("FREQ=MONTHLY") || repeat.contains("每月") {
            "monthly"
        } else if upper_repeat.contains("FREQ=YEARLY") || repeat.contains("每年") {
            "yearly"
        } else {
            "none"
        };
        let complex_interval = interval
            .captures(&upper_repeat)
            .is_some_and(|cap| &cap[1] != "1");
        let complex = !repeat.is_empty()
            && (rule == "none"
                || complex_interval
                || [
                    "BYDAY=",
                    "BYMONTHDAY=",
                    "BYMONTH=",
                    "UNTIL=",
                    "COUNT=",
                    "DFROM=",
                    "ERULE:",
                ]
                .iter()
                .any(|flag| upper_repeat.contains(flag)));
        let mut content = get(&["content", "description", "内容", "描述"]).to_owned();
        if complex {
            rule = "none";
            warnings.push(format!(
                "第 {} 行的复杂重复规则未转换，原规则已保留在任务描述中，请在导入后检查",
                index + 1
            ));
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(&format!("原重复规则：{repeat}"));
        }
        let all_day = ["true", "1"].contains(&get(&["is all day", "全天"]).to_lowercase().as_str());
        let tags: Vec<_> = get(&["tags", "标签"])
            .split([',', ';', '，'])
            .map(|v| v.trim_start_matches('#').trim())
            .filter(|v| !v.is_empty())
            .collect();
        let stable_input = format!(
            "{{\"row\":{},\"index\":{index}}}",
            serde_json::to_string(row).unwrap()
        );
        let start_day = match (&start.0, &due.0) {
            (Some(start), Some(due)) if start <= due => Some(start.clone()),
            _ => None,
        };
        data.tasks.push(domain::new_task(json!({
            "id": stable_id(&stable_input), "title": title, "listId": list_id, "content": content,
            "dueDate": due.0.or(start.0), "startDate": start_day, "time": if all_day { None } else { due.1.or(start.1) },
            "priority": priority, "repeat": rule, "tags": tags,
            "completedAt": completion.map(domain::stamp).or_else(|| ["2", "completed", "已完成"].contains(&status.as_str()).then(|| domain::stamp(now))),
            "createdAt": domain::stamp(created.unwrap_or(now))
        }), now)?);
    }
    validation::app(&mut data)?;
    Ok(Imported {
        data,
        approvals: vec![],
        warnings,
        entity_versions: BTreeMap::new(),
    })
}
