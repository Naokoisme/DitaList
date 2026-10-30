//! Physical-pixel placement; snap distance and edge-handle thickness are in DIP.
use windows::Win32::Foundation::{POINT, RECT};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Edge {
    #[default]
    Free,
    Start,
    End,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Dock {
    horizontal: Edge,
    vertical: Edge,
}

impl Dock {
    pub(super) fn is_docked(self) -> bool {
        self.horizontal != Edge::Free || self.vertical != Edge::Free
    }

    /// Called once when a drag ends. Corners may attach on both axes.
    pub(super) fn after_drag(rect: RECT, work: RECT, dpi: f32) -> Self {
        let distance = (16. * dpi / 96.).round() as i32;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let x = rect
            .left
            .clamp(work.left, (work.right - width).max(work.left));
        let y = rect
            .top
            .clamp(work.top, (work.bottom - height).max(work.top));
        Self {
            horizontal: nearest_edge(x - work.left, (work.right - x - width).max(0), distance),
            vertical: nearest_edge(y - work.top, (work.bottom - y - height).max(0), distance),
        }
    }

    /// Keep a docked edge fixed when counts, DPI, or the monitor work area change.
    pub(super) fn position(self, previous: RECT, width: i32, height: i32, work: RECT) -> POINT {
        POINT {
            x: position_axis(
                self.horizontal,
                if self.vertical != Edge::Free && self.horizontal == Edge::Free {
                    // A fixed center keeps a top/bottom handle still when
                    // newly pending items increase the expanded bar's width.
                    previous.left + (previous.right - previous.left - width) / 2
                } else {
                    previous.right - width
                },
                width,
                work.left,
                work.right,
            ),
            y: position_axis(self.vertical, previous.top, height, work.top, work.bottom),
        }
    }

    /// The handle stays inside the expanded bar, so revealing it never leaves
    /// a dead gap between the cursor at the edge and the available controls.
    pub(super) fn collapsed_rect(self, expanded: RECT, work: RECT, dpi: f32) -> RECT {
        let thickness = (4. * dpi / 96.).round().max(1.) as i32;
        let max_length = (64. * dpi / 96.).round() as i32;
        let mut rect = expanded;
        if self.horizontal != Edge::Free {
            let length = (expanded.bottom - expanded.top)
                .min(max_length)
                .min(work.bottom - work.top);
            rect.top = (rect.top + (expanded.bottom - expanded.top - length) / 2)
                .clamp(work.top, work.bottom - length);
            rect.bottom = rect.top + length;
            if self.horizontal == Edge::Start {
                rect.left = work.left;
                rect.right = (work.left + thickness).min(work.right);
            } else {
                rect.right = work.right;
                rect.left = (work.right - thickness).max(work.left);
            }
        } else if self.vertical != Edge::Free {
            let length = (expanded.right - expanded.left)
                .min(max_length)
                .min(work.right - work.left);
            rect.left = (rect.left + (expanded.right - expanded.left - length) / 2)
                .clamp(work.left, work.right - length);
            rect.right = rect.left + length;
            if self.vertical == Edge::Start {
                rect.top = work.top;
                rect.bottom = (work.top + thickness).min(work.bottom);
            } else {
                rect.bottom = work.bottom;
                rect.top = (work.bottom - thickness).max(work.top);
            }
        }
        rect
    }
}

fn nearest_edge(start: i32, end: i32, distance: i32) -> Edge {
    if start <= distance && start <= end {
        Edge::Start
    } else if end <= distance {
        Edge::End
    } else {
        Edge::Free
    }
}

fn position_axis(edge: Edge, current: i32, size: i32, start: i32, end: i32) -> i32 {
    let last = (end - size).max(start);
    match edge {
        Edge::Free => current,
        Edge::Start => start,
        Edge::End => last,
    }
    .clamp(start, last)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: RECT = RECT {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1040,
    };

    fn rect(x: i32, y: i32, width: i32, height: i32) -> RECT {
        RECT {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
        }
    }

    #[test]
    fn interior_drop_stays_free_and_a_corner_attaches_on_both_axes() {
        assert_eq!(
            Dock::after_drag(rect(600, 500, 180, 40), WORK, 96.),
            Dock::default()
        );
        let corner = rect(14, 989, 180, 40);
        let position = Dock::after_drag(corner, WORK, 96.).position(corner, 180, 40, WORK);
        assert_eq!((position.x, position.y), (0, 1000));
    }

    #[test]
    fn threshold_scales_with_dpi_and_expansion_meets_the_edge() {
        let inside = rect(24, 300, 270, 60);
        let outside = rect(25, 300, 270, 60);
        assert_eq!(Dock::after_drag(inside, WORK, 144.).horizontal, Edge::Start);
        assert_eq!(Dock::after_drag(outside, WORK, 144.).horizontal, Edge::Free);
        let position = Dock::after_drag(inside, WORK, 144.).position(inside, 270, 60, WORK);
        assert_eq!(position.x, 0);
    }

    #[test]
    fn secondary_monitor_can_have_negative_coordinates_and_a_top_taskbar() {
        let work = RECT {
            left: -2560,
            top: -1360,
            right: 0,
            bottom: 0,
        };
        let previous = rect(-2550, -1355, 360, 80);
        let position = Dock::after_drag(previous, work, 192.).position(previous, 360, 80, work);
        assert_eq!((position.x, position.y), (-2560, -1360));
    }

    #[test]
    fn docked_left_edge_stays_put_when_the_bar_grows_and_dpi_changes() {
        let previous = rect(8, 300, 180, 40);
        let dock = Dock::after_drag(previous, WORK, 96.);
        let position = dock.position(previous, 648, 60, WORK);
        assert_eq!((position.x, position.y), (0, 300));
    }

    #[test]
    fn bottom_right_dock_uses_the_new_work_area_and_excludes_the_taskbar() {
        let previous = rect(1732, 992, 180, 40);
        let dock = Dock::after_drag(previous, WORK, 96.);
        let changed = RECT {
            left: 80,
            top: 0,
            right: 1600,
            bottom: 900,
        };
        let position = dock.position(previous, 384, 40, changed);
        assert_eq!((position.x, position.y), (1216, 860));
    }

    #[test]
    fn off_screen_or_too_large_rectangles_remain_at_the_available_work_area_origin() {
        let previous = rect(-1000, -1000, 180, 40);
        let work = RECT {
            left: 40,
            top: 40,
            right: 160,
            bottom: 70,
        };
        let position = Dock::after_drag(previous, work, 96.).position(previous, 180, 40, work);
        assert_eq!((position.x, position.y), (40, 40));
    }

    #[test]
    fn each_edge_collapses_to_a_thin_handle_inside_the_expanded_bar() {
        for (expanded, expected) in [
            (rect(0, 300, 180, 40), rect(0, 300, 4, 40)),
            (rect(1740, 300, 180, 40), rect(1916, 300, 4, 40)),
            (rect(600, 0, 180, 40), rect(658, 0, 64, 4)),
            (rect(600, 1000, 180, 40), rect(658, 1036, 64, 4)),
        ] {
            let dock = Dock::after_drag(expanded, WORK, 96.);
            assert!(dock.is_docked());
            assert_eq!(dock.collapsed_rect(expanded, WORK, 96.), expected);
        }
        assert!(!Dock::after_drag(rect(600, 300, 180, 40), WORK, 96.).is_docked());
    }

    #[test]
    fn corner_handle_has_one_orientation_and_scales_on_negative_monitors() {
        let work = RECT {
            left: -2560,
            top: -1360,
            right: 0,
            bottom: 0,
        };
        let expanded = rect(-2560, -1360, 360, 80);
        let dock = Dock::after_drag(expanded, work, 192.);
        assert_eq!(
            dock.collapsed_rect(expanded, work, 192.),
            rect(-2560, -1360, 8, 80)
        );
    }

    #[test]
    fn hidden_handle_does_not_move_when_counts_expand_a_top_bar() {
        let previous = rect(600, 0, 180, 40);
        let dock = Dock::after_drag(previous, WORK, 96.);
        let position = dock.position(previous, 424, 40, WORK);
        let expanded = rect(position.x, position.y, 424, 40);
        assert_eq!(
            dock.collapsed_rect(expanded, WORK, 96.),
            rect(658, 0, 64, 4)
        );
    }

    #[test]
    fn hidden_handle_fits_even_when_work_area_is_smaller_than_the_full_bar() {
        let work = rect(-20, -10, 30, 20);
        let expanded = rect(-20, -10, 180, 40);
        let dock = Dock::after_drag(expanded, work, 96.);
        assert_eq!(
            dock.collapsed_rect(expanded, work, 96.),
            rect(-20, -10, 4, 20)
        );
    }
}
