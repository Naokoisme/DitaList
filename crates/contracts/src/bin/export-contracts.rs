use ditalist_contracts::*;
use ts_rs::TS;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut output = String::from("// Generated from crates/contracts. Do not edit.\n");
    let config = ts_rs::Config::default();
    macro_rules! emit { ($($t:ty),*) => { $(output.push_str("export "); output.push_str(&<$t>::decl(&config)); output.push('\n');)* }; }
    emit!(
        serde_json::Value,
        Subtask,
        Task,
        TaskList,
        Folder,
        Habit,
        SavedFilter,
        FocusSession,
        NavigationPreferences,
        Settings,
        AppData,
        Preferences,
        Approval,
        ReminderEvent,
        FocusState,
        CoreSnapshot,
        CoreCommand,
        CommandReceipt,
        CoreError,
        Operation,
        QuickDraft,
        McpInfo,
        ListMoveTarget
    );
    std::fs::create_dir_all(root.join("src/generated"))?;
    std::fs::write(root.join("src/generated/contracts.ts"), output)?;
    std::fs::create_dir_all(root.join("docs/schema"))?;
    std::fs::write(
        root.join("docs/schema/command.json"),
        serde_json::to_string_pretty(&schemars::schema_for!(CoreCommand))?,
    )?;
    Ok(())
}
