use crate::{domain, validation};
use chrono::{DateTime, Duration, Utc};
use ditalist_contracts::*;

#[derive(Clone)]
pub(crate) struct Runtime {
    state: FocusState,
    session_id: Option<String>,
    deadline: Option<DateTime<Utc>>,
}

impl Runtime {
    pub fn new(data: &AppData) -> Self {
        let mut state = FocusState::default();
        state.target_seconds = data.settings.pomodoro_minutes * 60;
        state.remaining_seconds = state.target_seconds;
        Self {
            state,
            session_id: None,
            deadline: None,
        }
    }
    pub fn snapshot(&self, now: DateTime<Utc>) -> FocusState {
        let mut state = self.state.clone();
        state.deadline = self.deadline.map(domain::stamp);
        if state.running {
            let millis = self
                .deadline
                .map(|deadline| (deadline - now).num_milliseconds().max(0))
                .unwrap_or(0);
            state.remaining_seconds = ((millis + 999) / 1000) as u32;
            state.remaining_seconds = state.remaining_seconds.min(state.target_seconds);
            state.elapsed_seconds = state.target_seconds.saturating_sub(state.remaining_seconds);
        }
        state
    }
    pub fn deadline(&self) -> Option<DateTime<Utc>> {
        self.deadline
    }
    pub fn running(&self) -> bool {
        self.state.running
    }

    fn save_session(&mut self, data: &mut AppData, completed: bool, now: DateTime<Utc>) {
        let current = self.snapshot(now);
        let seconds = if completed {
            current.target_seconds
        } else {
            current.elapsed_seconds
        };
        if self.state.mode != "focus" || seconds == 0 {
            return;
        }
        let Some(id) = self.session_id.take() else {
            return;
        };
        if data.focus_sessions.iter().any(|entry| entry.id == id) {
            return;
        }
        data.focus_sessions.push(FocusSession {
            id,
            task_id: current.task_id,
            title: current.title,
            started_at: current
                .started_at
                .unwrap_or_else(|| domain::stamp(now - Duration::seconds(i64::from(seconds)))),
            ended_at: domain::stamp(now),
            duration_seconds: seconds,
            completed,
        });
    }

    fn reset(&mut self, data: &AppData) {
        let mode = self.state.mode.clone();
        let seconds = if mode == "break" {
            data.settings.break_minutes
        } else {
            data.settings.pomodoro_minutes
        } * 60;
        let task_id = self.state.task_id.clone();
        let title = self.state.title.clone();
        self.state = FocusState {
            mode,
            running: false,
            task_id,
            title,
            started_at: None,
            deadline: None,
            remaining_seconds: seconds,
            elapsed_seconds: 0,
            target_seconds: seconds,
        };
        self.session_id = None;
        self.deadline = None;
    }

    pub fn settings_changed(&mut self, data: &AppData) {
        if !self.state.running && self.state.started_at.is_none() {
            self.reset(data);
        }
    }

    pub fn act(
        &mut self,
        data: &mut AppData,
        action: &str,
        task_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), CoreError> {
        match action {
            "start" | "resume" => {
                if self.state.running {
                    return Ok(());
                }
                if self.state.remaining_seconds == 0 {
                    self.reset(data);
                }
                if self.state.started_at.is_none() {
                    let selected = task_id.and_then(|id| {
                        data.tasks.iter().find(|task| {
                            task.id == id
                                && task.deleted_at.is_none()
                                && task.completed_at.is_none()
                                && task.agent_status == "approved"
                        })
                    });
                    if task_id.is_some() && selected.is_none() {
                        return Err(validation::invalid("请选择有效的已确认任务"));
                    }
                    self.state.task_id = selected.map(|task| task.id.clone());
                    self.state.title = selected
                        .map(|task| task.title.clone())
                        .unwrap_or_else(|| "自由专注".into());
                    self.state.started_at = Some(domain::stamp(now));
                    self.session_id = Some(domain::uid());
                }
                self.state.running = true;
                self.deadline =
                    Some(now + Duration::seconds(i64::from(self.state.remaining_seconds)));
            }
            "pause" => {
                self.state = self.snapshot(now);
                self.state.running = false;
                self.state.deadline = None;
                self.deadline = None;
            }
            "reset" | "stop" => {
                self.save_session(data, false, now);
                self.reset(data);
            }
            "focus" | "break" => {
                if self.state.mode != action {
                    self.save_session(data, false, now);
                    self.state.mode = action.into();
                    self.reset(data);
                }
            }
            _ => return Err(validation::invalid("不支持的专注操作")),
        }
        Ok(())
    }

    pub fn tick(&mut self, data: &mut AppData, now: DateTime<Utc>) -> Option<String> {
        if !self.state.running || self.deadline.is_none_or(|deadline| deadline > now) {
            return None;
        }
        self.save_session(data, true, now);
        self.state.remaining_seconds = 0;
        self.state.elapsed_seconds = self.state.target_seconds;
        self.state.running = false;
        self.state.deadline = None;
        self.deadline = None;
        self.state.started_at = None;
        self.session_id = None;
        Some(
            if self.state.mode == "focus" {
                "专注已完成，休息一下吧。"
            } else {
                "休息结束。"
            }
            .into(),
        )
    }
}
