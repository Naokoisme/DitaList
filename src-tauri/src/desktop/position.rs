//! Physical-pixel placement; only the snap distance and inset are expressed in DIP.
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
            horizontal: nearest_edge(x - work.left, work.right - x - width, distance),
            vertical: nearest_edge(y - work.top, work.bottom - y - height, distance),
        }
    }

    /// Keep a docked edge fixed when counts, DPI, or the monitor work area change.
    pub(super) fn position(
        self,
        previous: RECT,
        width: i32,
        height: i32,
        work: RECT,
        dpi: f32,
    ) -> POINT {
        let inset = (8. * dpi / 96.).round() as i32;
        POINT {
            x: position_axis(
                self.horizontal,
                previous.right - width,
                width,
                work.left,
                work.right,
                inset,
            ),
            y: position_axis(
                self.vertical,
                previous.top,
                height,
                work.top,
                work.bottom,
                inset,
            ),
        }
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

fn position_axis(edge: Edge, current: i32, size: i32, start: i32, end: i32, inset: i32) -> i32 {
    let last = (end - size).max(start);
    match edge {
        Edge::Free => current,
        Edge::Start => start + inset,
        Edge::End => last - inset,
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
        let position = Dock::after_drag(corner, WORK, 96.).position(corner, 180, 40, WORK, 96.);
        assert_eq!((position.x, position.y), (8, 992));
    }

    #[test]
    fn threshold_and_inset_scale_with_dpi() {
        let inside = rect(24, 300, 270, 60);
        let outside = rect(25, 300, 270, 60);
        assert_eq!(Dock::after_drag(inside, WORK, 144.).horizontal, Edge::Start);
        assert_eq!(Dock::after_drag(outside, WORK, 144.).horizontal, Edge::Free);
        let position = Dock::after_drag(inside, WORK, 144.).position(inside, 270, 60, WORK, 144.);
        assert_eq!(position.x, 12);
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
        let position =
            Dock::after_drag(previous, work, 192.).position(previous, 360, 80, work, 192.);
        assert_eq!((position.x, position.y), (-2544, -1344));
    }

    #[test]
    fn docked_left_edge_stays_put_when_the_bar_grows_and_dpi_changes() {
        let previous = rect(8, 300, 180, 40);
        let dock = Dock::after_drag(previous, WORK, 96.);
        let position = dock.position(previous, 648, 60, WORK, 144.);
        assert_eq!((position.x, position.y), (12, 300));
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
        let position = dock.position(previous, 384, 40, changed, 96.);
        assert_eq!((position.x, position.y), (1208, 852));
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
        let position = Dock::after_drag(previous, work, 96.).position(previous, 180, 40, work, 96.);
        assert_eq!((position.x, position.y), (40, 40));
    }
}
