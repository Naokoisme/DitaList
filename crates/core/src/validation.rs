use chrono::{DateTime, NaiveDate, NaiveTime};
use ditalist_contracts::*;
use serde_json::{Value, json};
use std::collections::HashSet;

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new("invalid_input", message)
}

pub(crate) fn text(value: &str, name: &str, min: usize, max: usize) -> Result<(), CoreError> {
    let n = value.encode_utf16().count();
    if n < min || n > max || (min > 0 && value.trim().is_empty()) {
        return Err(invalid(format!("{name}长度须在 {min}–{max} 字符之间")));
    }
    Ok(())
}

pub(crate) fn id(value: &str) -> Result<(), CoreError> {
    text(value, "ID", 1, 160)
}

pub(crate) fn date(value: &str) -> Result<NaiveDate, CoreError> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("日期必须是有效的 YYYY-MM-DD"))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(invalid("日期必须是有效的 YYYY-MM-DD"));
    }
    Ok(parsed)
}

pub(crate) fn time(value: &str) -> Result<NaiveTime, CoreError> {
    let parsed =
        NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| invalid("时间必须是 HH:mm"))?;
    if parsed.format("%H:%M").to_string() != value {
        return Err(invalid("时间必须是 HH:mm"));
    }
    Ok(parsed)
}

pub(crate) fn timestamp(value: &str) -> Result<(), CoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| invalid("时间戳无效"))
}

pub(crate) fn color(value: &str) -> Result<(), CoreError> {
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid("颜色必须是 #RRGGBB"));
    }
    Ok(())
}

fn one_of(value: &str, allowed: &[&str], name: &str) -> Result<(), CoreError> {
    if !allowed.contains(&value) {
        return Err(invalid(format!("不支持的{name}：{value}")));
    }
    Ok(())
}

pub(crate) fn task(task: &mut Task) -> Result<(), CoreError> {
    id(&task.id)?;
    task.title = task.title.trim().into();
    text(&task.title, "任务标题", 1, 10_000)?;
    text(&task.content, "任务内容", 0, 2_000_000)?;
    id(&task.list_id)?;
    if let Some(v) = &task.start_date {
        date(v)?;
    }
    if let Some(v) = &task.due_date {
        date(v)?;
    }
    if let Some(v) = &task.recurrence_anchor {
        date(v)?;
    }
    if let Some(v) = &task.recurrence_id {
        id(v)?;
    }
    if let (Some(start), Some(end)) = (&task.start_date, &task.due_date)
        && start > end
    {
        return Err(invalid("开始日期不能晚于结束日期"));
    }
    for value in [&task.time, &task.end_time].into_iter().flatten() {
        time(value)?;
    }
    if task.priority > 3 {
        return Err(invalid("优先级必须为 0、1、2 或 3"));
    }
    one_of(
        &task.repeat,
        &["none", "daily", "weekdays", "weekly", "monthly", "yearly"],
        "重复规则",
    )?;
    one_of(
        &task.reminder,
        &["none", "at-time", "5m", "15m", "30m", "1h", "1d"],
        "提醒规则",
    )?;
    one_of(&task.created_by, &["user", "agent"], "任务来源")?;
    one_of(&task.agent_status, &["pending", "approved"], "审核状态")?;
    timestamp(&task.created_at)?;
    timestamp(&task.updated_at)?;
    for value in [&task.completed_at, &task.deleted_at].into_iter().flatten() {
        timestamp(value)?;
    }
    if !task.sort_order.is_finite() {
        return Err(invalid("排序值无效"));
    }
    if task.tags.len() > 200 {
        return Err(invalid("单个任务最多 200 个标签"));
    }
    for tag in &mut task.tags {
        *tag = tag.trim().into();
        text(tag, "标签", 1, 200)?;
    }
    if task.subtasks.len() > 10_000 {
        return Err(invalid("子任务过多"));
    }
    let mut subtask_ids = HashSet::new();
    for subtask in &task.subtasks {
        id(&subtask.id)?;
        text(&subtask.title, "子任务标题", 0, 10_000)?;
        if !subtask_ids.insert(&subtask.id) {
            return Err(invalid("任务中存在重复的子任务 ID"));
        }
    }
    Ok(())
}

pub(crate) fn settings(settings: &mut Settings) -> Result<(), CoreError> {
    one_of(&settings.theme, &["light", "dark", "system"], "主题")?;
    color(&settings.accent)?;
    if settings.week_start > 1 {
        return Err(invalid("每周起始日只能为周日或周一"));
    }
    one_of(
        &settings.calendar_mode,
        &["month", "week", "day", "agenda"],
        "日历模式",
    )?;
    let view = &settings.default_view;
    if ![
        "today",
        "next7",
        "inbox",
        "all",
        "calendar",
        "matrix",
        "focus",
        "habits",
        "completed",
        "trash",
    ]
    .contains(&view.as_str())
        && !["list:", "tag:", "filter:"]
            .iter()
            .any(|prefix| view.starts_with(prefix) && view.len() > prefix.len())
    {
        return Err(invalid("默认视图无效"));
    }
    if !(1..=180).contains(&settings.pomodoro_minutes)
        || !(1..=60).contains(&settings.break_minutes)
    {
        return Err(invalid("专注或休息时长超出范围"));
    }
    settings.floating_shortcut = settings.floating_shortcut.trim().into();
    text(&settings.floating_shortcut, "快捷键", 0, 100)?;
    id(&settings.floating_default_list_id)?;
    one_of(
        &settings.floating_default_date,
        &["none", "today", "tomorrow"],
        "默认日期",
    )?;
    if settings.custom_tags.len() > 500 {
        return Err(invalid("自定义标签过多"));
    }
    for tag in &mut settings.custom_tags {
        *tag = tag.trim().into();
        text(tag, "标签", 1, 200)?;
    }
    navigation(&settings.navigation)?;
    Ok(())
}

pub(crate) fn navigation(preferences: &NavigationPreferences) -> Result<(), CoreError> {
    if preferences.orders.len() > 10_005 {
        return Err(invalid("导航分组过多"));
    }
    if preferences.hidden.len() > 50_000 {
        return Err(invalid("隐藏导航项目过多"));
    }
    for (group, items) in &preferences.orders {
        text(group, "导航分组", 1, 200)?;
        if items.len() > 20_000 {
            return Err(invalid("单个导航分组的项目过多"));
        }
        for item in items {
            text(item, "导航项目", 1, 240)?;
        }
    }
    for item in &preferences.hidden {
        text(item, "导航项目", 1, 240)?;
    }
    Ok(())
}

fn unique<'a>(values: impl Iterator<Item = &'a str>, name: &str) -> Result<(), CoreError> {
    let mut seen = HashSet::new();
    for value in values {
        id(value)?;
        if !seen.insert(value) {
            return Err(invalid(format!("数据中存在重复的 {name} ID")));
        }
    }
    Ok(())
}

pub(crate) fn app(data: &mut AppData) -> Result<(), CoreError> {
    if data.schema_version != 1 {
        return Err(CoreError::new("unsupported_format", "不支持的业务数据格式"));
    }
    if data.tasks.len() > 200_000
        || data.focus_sessions.len() > 200_000
        || [
            data.lists.len(),
            data.folders.len(),
            data.habits.len(),
            data.filters.len(),
        ]
        .iter()
        .any(|n| *n > 10_000)
    {
        return Err(invalid("数据条目超过支持范围"));
    }
    unique(data.tasks.iter().map(|x| x.id.as_str()), "tasks")?;
    unique(data.lists.iter().map(|x| x.id.as_str()), "lists")?;
    unique(data.folders.iter().map(|x| x.id.as_str()), "folders")?;
    unique(data.habits.iter().map(|x| x.id.as_str()), "habits")?;
    unique(data.filters.iter().map(|x| x.id.as_str()), "filters")?;
    unique(
        data.focus_sessions.iter().map(|x| x.id.as_str()),
        "focusSessions",
    )?;
    for folder in &mut data.folders {
        folder.name = folder.name.trim().into();
        text(&folder.name, "文件夹名称", 1, 500)?;
        if !folder.sort_order.is_finite() {
            return Err(invalid("文件夹排序无效"));
        }
    }
    let folder_ids: HashSet<_> = data.folders.iter().map(|x| x.id.as_str()).collect();
    for list in &mut data.lists {
        list.name = list.name.trim().into();
        text(&list.name, "清单名称", 1, 500)?;
        color(&list.color)?;
        if !list.sort_order.is_finite() {
            return Err(invalid("清单排序无效"));
        }
        if let Some(folder) = &list.folder_id
            && !folder_ids.contains(folder.as_str())
        {
            return Err(invalid("清单引用了不存在的文件夹"));
        }
    }
    let list_ids: HashSet<_> = data.lists.iter().map(|x| x.id.as_str()).collect();
    if !list_ids.contains("inbox") {
        return Err(invalid("数据缺少收集箱"));
    }
    for t in &mut data.tasks {
        task(t)?;
        if !list_ids.contains(t.list_id.as_str()) {
            return Err(invalid("任务引用了不存在的清单"));
        }
    }
    for habit in &mut data.habits {
        habit.name = habit.name.trim().into();
        text(&habit.name, "习惯名称", 1, 500)?;
        text(&habit.icon, "习惯图标", 0, 100)?;
        color(&habit.color)?;
        if !(1..=1_000_000).contains(&habit.goal)
            || habit.days.len() > 7
            || habit.days.iter().any(|day| *day > 6)
        {
            return Err(invalid("习惯目标或星期无效"));
        }
        timestamp(&habit.created_at)?;
        for (day, count) in &habit.records {
            date(day)?;
            if *count > 1_000_000 {
                return Err(invalid("习惯记录超出范围"));
            }
        }
    }
    for filter in &mut data.filters {
        filter.name = filter.name.trim().into();
        text(&filter.name, "筛选名称", 1, 500)?;
        text(&filter.query, "筛选条件", 0, 10_000)?;
        color(&filter.color)?;
    }
    for focus in &data.focus_sessions {
        if let Some(task_id) = &focus.task_id {
            id(task_id)?;
        }
        text(&focus.title, "专注标题", 0, 10_000)?;
        timestamp(&focus.started_at)?;
        timestamp(&focus.ended_at)?;
        if focus.duration_seconds > 604_800 {
            return Err(invalid("专注时长超出范围"));
        }
    }
    settings(&mut data.settings)?;
    if !data
        .lists
        .iter()
        .any(|list| list.id == data.settings.floating_default_list_id && !list.archived)
    {
        data.settings.floating_default_list_id = "inbox".into();
    }
    Ok(())
}

/// The old schema supplies defaults for fields introduced after its first release.
pub(crate) fn decode_legacy(mut value: Value) -> Result<AppData, CoreError> {
    if let Some(settings) = value.get_mut("settings").and_then(Value::as_object_mut) {
        for (key, default) in [
            ("floatingShortcut", json!("CommandOrControl+Alt+Space")),
            ("floatingDefaultListId", json!("inbox")),
            ("floatingDefaultDate", json!("today")),
            ("customTags", json!([])),
        ] {
            settings.entry(key).or_insert(default);
        }
    }
    let mut data: AppData =
        serde_json::from_value(value).map_err(|e| invalid(format!("业务数据格式错误：{e}")))?;
    app(&mut data)?;
    Ok(data)
}

pub(crate) fn patch_known(
    target: &mut Value,
    patch: &Value,
    fields: &[&str],
) -> Result<(), CoreError> {
    let patch = patch
        .as_object()
        .ok_or_else(|| invalid("修改内容必须是对象"))?;
    let target = target
        .as_object_mut()
        .ok_or_else(|| invalid("修改目标无效"))?;
    for (key, value) in patch {
        if !fields.contains(&key.as_str()) {
            return Err(invalid(format!("不允许修改字段：{key}")));
        }
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}
