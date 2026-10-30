//! Transient, premultiplied-alpha canvas. It exists only while the bar morphs;
//! the idle bar keeps its standard, accessible Win32 buttons and has no ticker.
use super::*;

pub(super) struct Surface {
    renderer: Renderer,
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    #[cfg(test)]
    pixels: *mut c_void,
    width: i32,
    height: i32,
    dpi_scale: f32,
    theme: Theme,
    fill: ID2D1SolidColorBrush,
    border: ID2D1SolidColorBrush,
    ink: ID2D1SolidColorBrush,
    accent: ID2D1SolidColorBrush,
    labels: Vec<(f32, bool, IDWriteTextLayout)>,
}

impl Surface {
    pub(super) unsafe fn new(
        width: i32,
        height: i32,
        dpi_scale: f32,
        buttons: &[Button],
        theme: Theme,
    ) -> windows::core::Result<Self> {
        unsafe {
            let renderer = Renderer::with_alpha(D2D1_ALPHA_MODE_PREMULTIPLIED)?;
            renderer
                .target
                .SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            let fill = renderer
                .target
                .CreateSolidColorBrush(&theme.surface, None)?;
            let border = renderer.target.CreateSolidColorBrush(&theme.border, None)?;
            let ink = renderer.target.CreateSolidColorBrush(&theme.text, None)?;
            let accent = renderer.target.CreateSolidColorBrush(&theme.accent, None)?;
            let format = renderer.write.CreateTextFormat(
                w!("Microsoft YaHei UI"),
                None,
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                14. * dpi_scale,
                w!("zh-cn"),
            )?;
            format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)?;
            format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
            let mut labels = Vec::new();
            for button in buttons.iter().filter(|b| b.shown) {
                labels.push((
                    button.left * dpi_scale + 3.,
                    button.id == ADD,
                    renderer.write.CreateTextLayout(
                        &button.label.encode_utf16().collect::<Vec<_>>(),
                        &format,
                        button.width * dpi_scale - 6.,
                        height as f32,
                    )?,
                ));
            }
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err(windows::core::Error::from_thread());
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = std::ptr::null_mut();
            let bitmap =
                match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut pixels, None, 0) {
                    Ok(bitmap) => bitmap,
                    Err(error) => {
                        let _ = DeleteDC(dc);
                        return Err(error);
                    }
                };
            let previous = SelectObject(dc, bitmap.into());
            if previous.is_invalid() {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
                return Err(windows::core::Error::from_thread());
            }
            Ok(Self {
                renderer,
                dc,
                bitmap,
                previous,
                #[cfg(test)]
                pixels,
                width,
                height,
                dpi_scale,
                theme,
                fill,
                border,
                ink,
                accent,
                labels,
            })
        }
    }

    unsafe fn draw(&self, width: i32, height: i32, progress: f32) -> windows::core::Result<()> {
        unsafe {
            let target = &self.renderer.target;
            target.BindDC(
                self.dc,
                &RECT {
                    left: 0,
                    top: 0,
                    right: self.width,
                    bottom: self.height,
                },
            )?;
            let mut identity = Default::default();
            target.GetTransform(&mut identity);
            identity.M11 = 1.;
            identity.M12 = 0.;
            identity.M21 = 0.;
            identity.M22 = 1.;
            identity.M31 = 0.;
            identity.M32 = 0.;
            target.SetTransform(&identity);
            target.BeginDraw();
            target.Clear(Some(&D2D1_COLOR_F::default()));
            // The white edge handle becomes the theme's surface continuously.
            let p = progress * progress * (3. - 2. * progress);
            self.fill.SetColor(&D2D1_COLOR_F {
                r: 1. + (self.theme.surface.r - 1.) * p,
                g: 1. + (self.theme.surface.g - 1.) * p,
                b: 1. + (self.theme.surface.b - 1.) * p,
                a: 1.,
            });
            self.border.SetOpacity(p);
            let radius = (8. * self.dpi_scale)
                .min(width as f32 / 2.)
                .min(height as f32 / 2.);
            let shape = D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: 0.,
                    top: 0.,
                    right: width as f32,
                    bottom: height as f32,
                },
                radiusX: radius,
                radiusY: radius,
            };
            target.FillRoundedRectangle(&shape, &self.fill);
            let outline = D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: 0.5,
                    top: 0.5,
                    right: width as f32 - 0.5,
                    bottom: height as f32 - 0.5,
                },
                radiusX: (radius - 0.5).max(0.),
                radiusY: (radius - 0.5).max(0.),
            };
            target.DrawRoundedRectangle(&outline, &self.border, 1., None);

            // One uniform content transform; never squash text or reveal it
            // through the old fixed-size child-window clipping rectangles.
            let scale = (width as f32 / self.width as f32).min(height as f32 / self.height as f32);
            let mut transform = identity;
            transform.M11 = scale;
            transform.M22 = scale;
            transform.M31 = (width as f32 - self.width as f32 * scale) / 2.;
            transform.M32 = (height as f32 - self.height as f32 * scale) / 2.;
            target.SetTransform(&transform);
            self.ink.SetOpacity(p);
            self.accent.SetOpacity(p);
            for (left, accent, layout) in &self.labels {
                target.DrawTextLayout(
                    windows_numerics::Vector2 { X: *left, Y: 0. },
                    layout,
                    if *accent { &self.accent } else { &self.ink },
                    D2D1_DRAW_TEXT_OPTIONS_CLIP,
                );
            }
            target.SetTransform(&identity);
            target.EndDraw(None, None)
        }
    }

    pub(super) unsafe fn present(
        &self,
        hwnd: HWND,
        rect: RECT,
        progress: f32,
    ) -> windows::core::Result<()> {
        unsafe {
            let size = SIZE {
                cx: rect.right - rect.left,
                cy: rect.bottom - rect.top,
            };
            self.draw(size.cx, size.cy, progress)?;
            UpdateLayeredWindow(
                hwnd,
                None,
                Some(&POINT {
                    x: rect.left,
                    y: rect.top,
                }),
                Some(&size),
                Some(self.dc),
                Some(&POINT::default()),
                COLORREF(0),
                Some(&BLENDFUNCTION {
                    BlendOp: AC_SRC_OVER as u8,
                    BlendFlags: 0,
                    SourceConstantAlpha: 255,
                    AlphaFormat: AC_SRC_ALPHA as u8,
                }),
                ULW_ALPHA,
            )
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buttons() -> Vec<Button> {
        [
            (DRAG, "⋮⋮", 40., 0.),
            (TODAY, "今天 3", 100., 40.),
            (ADD, "＋", 40., 140.),
        ]
        .into_iter()
        .map(|(id, label, width, left)| Button {
            hwnd: HWND::default(),
            id,
            label: label.into(),
            width,
            left,
            shown: true,
            tooltip: vec![],
        })
        .collect()
    }

    fn theme(dark: bool) -> Theme {
        let mut theme = Theme::from_snapshot(None);
        if dark {
            theme.surface = color("#292b30");
            theme.text = color("#e7e8ec");
            theme.border = color("#454850");
        }
        theme
    }

    #[test]
    fn production_canvas_preserves_alpha_white_handle_and_theme_at_each_dpi() {
        unsafe {
            for dpi in [1., 1.5, 2.] {
                for dark in [false, true] {
                    let surface = Surface::new(
                        (180. * dpi) as i32,
                        (40. * dpi) as i32,
                        dpi,
                        &buttons(),
                        theme(dark),
                    )
                    .unwrap();
                    let width = (4. * dpi) as i32;
                    let height = (24. * dpi) as i32;
                    surface.draw(width, height, 0.).unwrap();
                    let pixels = std::slice::from_raw_parts(
                        surface.pixels.cast::<u8>(),
                        (surface.width * surface.height * 4) as usize,
                    );
                    let middle = ((height / 2 * surface.width + width / 2) * 4) as usize;
                    assert_eq!(&pixels[middle..middle + 4], &[255, 255, 255, 255]);
                    assert!(pixels[3] < 255, "corners must remain transparent");
                    for pixel in pixels.chunks_exact(4) {
                        assert!(
                            pixel[..3].iter().all(|channel| *channel <= pixel[3]),
                            "must use premultiplied alpha"
                        );
                    }
                    surface.draw(surface.width, surface.height, 1.).unwrap();
                    let pixels = std::slice::from_raw_parts(
                        surface.pixels.cast::<u8>(),
                        (surface.width * surface.height * 4) as usize,
                    );
                    let center =
                        ((surface.height / 2 * surface.width + (28. * dpi) as i32) * 4) as usize;
                    assert_eq!(pixels[center + 3], 255);
                    if dark {
                        assert!(pixels[center] < 70);
                    } else {
                        assert!(pixels[center] > 240);
                    }
                }
            }
        }
    }

    #[test]
    fn layered_window_accepts_each_production_frame_without_opaque_corners() {
        unsafe {
            // Hidden HWND: exercise the real ULW boundary without showing a test
            // window, changing focus, or injecting input into the user's desktop.
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("DitaList motion test"),
                WS_POPUP,
                0,
                0,
                180,
                40,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let surface = Surface::new(180, 40, 1., &buttons(), theme(false)).unwrap();
            for (progress, width, height) in
                [(0., 4, 24), (0.25, 48, 28), (0.7, 127, 35), (1., 180, 40)]
            {
                let rect = RECT {
                    left: -width,
                    top: 100,
                    right: 0,
                    bottom: 100 + height,
                };
                let result = surface.present(hwnd, rect, progress);
                if result.is_err() {
                    let _ = DestroyWindow(hwnd);
                }
                result.unwrap();
                let mut actual = RECT::default();
                GetWindowRect(hwnd, &mut actual).unwrap();
                assert_eq!(actual, rect);
                assert!(!IsWindowVisible(hwnd).as_bool());
            }
            DestroyWindow(hwnd).unwrap();
        }
    }

    // Deliberately opt-in: these are the production D2D pixels, not a mockup.
    // The exporter does not create windows, inject input, or touch user data.
    #[test]
    #[ignore]
    fn export_production_motion_frames() {
        let folder = std::path::PathBuf::from(
            std::env::var_os("DITALIST_MOTION_FRAMES").expect("output directory"),
        );
        std::fs::create_dir_all(&folder).unwrap();
        let start = Instant::now();
        let mut spring = BarTransition::new(true, start);
        spring.retarget(false, start);
        let full = RECT {
            left: 0,
            top: 0,
            right: 270,
            bottom: 60,
        };
        let work = RECT {
            left: 0,
            top: 0,
            right: 270,
            bottom: 400,
        };
        let dock = Dock::after_drag(full, work, 144.);
        let line = dock.collapsed_rect(full, work, 144.);
        unsafe {
            let surface = Surface::new(270, 60, 1.5, &buttons(), theme(false)).unwrap();
            for frame in 0..96 {
                let now = start + Duration::from_millis(frame * 16);
                if frame == 46 {
                    spring.retarget(true, now);
                }
                let (progress, _) = spring.frame(now, 270.);
                let rect = transition_rect(line, full, progress);
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                surface.draw(width, height, progress).unwrap();
                let raw = std::slice::from_raw_parts(
                    surface.pixels.cast::<u8>(),
                    (surface.width * surface.height * 4) as usize,
                );
                let canvas_width = 310;
                let canvas_height = 100;
                let mut ppm = format!("P6\n{canvas_width} {canvas_height}\n255\n").into_bytes();
                for y in 0..canvas_height {
                    for x in 0..canvas_width {
                        let local_x = x - rect.left - 20;
                        let local_y = y - rect.top - 20;
                        let background = [213u8, 219, 229];
                        if local_x >= 0 && local_x < width && local_y >= 0 && local_y < height {
                            let at = ((local_y * surface.width + local_x) * 4) as usize;
                            let alpha = raw[at + 3] as u16;
                            for (channel, base) in [2, 1, 0].into_iter().zip(background) {
                                ppm.push(
                                    (raw[at + channel] as u16
                                        + (base as u16 * (255 - alpha) + 127) / 255)
                                        .min(255) as u8,
                                );
                            }
                        } else {
                            ppm.extend_from_slice(&background);
                        }
                    }
                }
                std::fs::write(folder.join(format!("{frame:03}.ppm")), ppm).unwrap();
            }
        }
    }
}
