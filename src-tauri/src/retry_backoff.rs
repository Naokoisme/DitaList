use std::time::{Duration, Instant};

/// Only background ticks are throttled. Notifications never reset this state.
#[derive(Default)]
pub(crate) struct TickRetry {
    retry_at: Option<Instant>,
    failures: u32,
    last_error: Option<(String, String, Instant)>,
    suppressed: u64,
}

impl TickRetry {
    pub(crate) fn delay(&self, now: Instant, core_delay_ms: Option<u64>) -> Option<Duration> {
        // A failed tick remains pending even if a command removes its original deadline.
        self.retry_at
            .map(|at| at.saturating_duration_since(now))
            .or_else(|| core_delay_ms.map(|ms| Duration::from_millis(ms.max(10))))
    }

    pub(crate) fn ready(&self, now: Instant) -> bool {
        self.retry_at.is_none_or(|at| now >= at)
    }

    /// Return the count of merged errors when a report is due (first/changed/60s).
    pub(crate) fn failed(&mut self, now: Instant, code: &str, message: &str) -> Option<u64> {
        self.failures = self.failures.saturating_add(1);
        let seconds = (1u64 << (self.failures - 1).min(5)).min(30);
        self.retry_at = Some(now + Duration::from_secs(seconds));
        let report = self
            .last_error
            .as_ref()
            .is_none_or(|(old_code, old_message, at)| {
                old_code != code
                    || old_message != message
                    || now.saturating_duration_since(*at) >= Duration::from_secs(60)
            });
        if report {
            self.last_error = Some((code.to_owned(), message.to_owned(), now));
            Some(std::mem::take(&mut self.suppressed))
        } else {
            self.suppressed = self.suppressed.saturating_add(1);
            None
        }
    }

    pub(crate) fn succeeded(&mut self) -> Option<u64> {
        let recovered = self.retry_at.is_some().then_some(self.suppressed);
        *self = Self::default();
        recovered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_delays_and_exact_boundaries() {
        let mut retry = TickRetry::default();
        let mut now = Instant::now();
        for seconds in [1, 2, 4, 8, 16, 30, 30, 30] {
            retry.failed(now, "storage", "disk full");
            let delay = Duration::from_secs(seconds);
            assert_eq!(retry.delay(now, Some(0)), Some(delay));
            assert!(!retry.ready(now + delay - Duration::from_nanos(1)));
            assert!(retry.ready(now + delay));
            assert_eq!(retry.delay(now + delay, Some(0)), Some(Duration::ZERO));
            now += delay;
        }
    }

    #[tokio::test]
    async fn ordinary_notifications_cannot_bypass_or_extend_retry() {
        let wake = tokio::sync::Notify::new();
        let mut retry = TickRetry::default();
        let now = Instant::now();
        retry.failed(now, "storage", "disk full");
        for millis in [0, 10, 100, 999] {
            wake.notify_one();
            wake.notified().await;
            let current = now + Duration::from_millis(millis);
            assert!(!retry.ready(current));
            // Even no remaining business deadline must retain the failed tick.
            assert_eq!(
                retry.delay(current, None),
                Some(Duration::from_millis(1000 - millis))
            );
        }
        assert!(retry.ready(now + Duration::from_secs(1)));
    }

    #[test]
    fn successful_empty_tick_restores_normal_scheduling_and_first_delay() {
        let now = Instant::now();
        let mut retry = TickRetry::default();
        retry.failed(now, "storage", "disk full");
        retry.failed(now + Duration::from_secs(1), "storage", "disk full");
        assert_eq!(retry.succeeded(), Some(1));
        assert!(retry.ready(now));
        assert_eq!(retry.delay(now, None), None);
        assert_eq!(retry.delay(now, Some(0)), Some(Duration::from_millis(10)));
        assert_eq!(
            retry.delay(now, Some(500)),
            Some(Duration::from_millis(500))
        );
        assert_eq!(retry.failed(now, "storage", "disk full"), Some(0));
        assert_eq!(retry.delay(now, None), Some(Duration::from_secs(1)));
    }

    #[test]
    fn identical_errors_are_merged_but_changed_errors_report_immediately() {
        let now = Instant::now();
        let mut retry = TickRetry::default();
        assert_eq!(retry.failed(now, "storage", "full"), Some(0));
        assert_eq!(
            retry.failed(now + Duration::from_secs(1), "storage", "full"),
            None
        );
        assert_eq!(
            retry.failed(now + Duration::from_secs(59), "storage", "full"),
            None
        );
        assert_eq!(
            retry.failed(now + Duration::from_secs(60), "storage", "full"),
            Some(2)
        );
        assert_eq!(
            retry.failed(now + Duration::from_secs(61), "storage", "denied"),
            Some(0)
        );
        assert_eq!(
            retry.failed(now + Duration::from_secs(62), "internal", "denied"),
            Some(0)
        );
    }
}
