use egui::{Color32, CornerRadius, FontId, RichText, Stroke, TextStyle};

pub(crate) const BACKGROUND: Color32 = Color32::from_rgb(24, 24, 25);
pub(crate) const PANEL: Color32 = Color32::from_rgb(28, 28, 29);
pub(crate) const CARD: Color32 = Color32::from_rgb(32, 32, 34);
pub(crate) const SURFACE: Color32 = Color32::from_rgb(37, 37, 39);
pub(crate) const TEXT: Color32 = Color32::from_rgb(247, 248, 248);
pub(crate) const MUTED: Color32 = Color32::from_rgb(138, 143, 152);
pub(crate) const ACCENT: Color32 = Color32::from_rgb(130, 143, 255);
pub(crate) const ACCENT_FILL: Color32 = Color32::from_rgb(229, 229, 230);
pub(crate) const BORDER: Color32 = Color32::from_rgb(46, 46, 49);
pub(crate) const ERROR: Color32 = Color32::from_rgb(236, 159, 155);

const PRIMARY_TEXT: Color32 = Color32::from_rgb(24, 24, 25);
const SELECTED: Color32 = Color32::from_rgb(48, 48, 51);
const HOVERED: Color32 = Color32::from_rgb(51, 51, 54);
const WARNING: Color32 = Color32::from_rgb(223, 191, 132);
const SUCCESS: Color32 = Color32::from_rgb(161, 191, 162);

pub(crate) fn apply(ctx: &egui::Context) {
    apply_fonts(ctx);
    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    style.visuals = egui::Visuals::dark();
    style.visuals.panel_fill = BACKGROUND;
    style.visuals.window_fill = PANEL;
    style.visuals.extreme_bg_color = BACKGROUND;
    style.visuals.text_edit_bg_color = Some(BACKGROUND);
    style.visuals.code_bg_color = BACKGROUND;
    style.visuals.faint_bg_color = CARD;
    style.visuals.override_text_color = Some(TEXT);
    style.visuals.weak_text_color = Some(MUTED);
    style.visuals.selection.bg_fill = SELECTED;
    style.visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    style.visuals.hyperlink_color = ACCENT;
    style.visuals.warn_fg_color = WARNING;
    style.visuals.error_fg_color = ERROR;
    style.visuals.text_cursor.stroke = Stroke::new(1.5, ACCENT);
    style.visuals.window_stroke = Stroke::new(1.0, BORDER);
    style.visuals.window_corner_radius = CornerRadius::same(7);
    style.visuals.menu_corner_radius = CornerRadius::same(5);
    style.visuals.window_shadow = egui::epaint::Shadow {
        offset: [0, 7],
        blur: 24,
        spread: 0,
        color: Color32::from_black_alpha(112),
    };
    style.visuals.popup_shadow = egui::epaint::Shadow {
        offset: [0, 6],
        blur: 16,
        spread: 0,
        color: Color32::from_black_alpha(96),
    };
    style.visuals.disabled_alpha = 0.45;

    let widgets = &mut style.visuals.widgets;
    for widget in [
        &mut widgets.noninteractive,
        &mut widgets.inactive,
        &mut widgets.hovered,
        &mut widgets.active,
        &mut widgets.open,
    ] {
        widget.corner_radius = CornerRadius::same(5);
        widget.expansion = 0.0;
        widget.fg_stroke = Stroke::new(1.0, TEXT);
        widget.bg_stroke = Stroke::new(1.0, BORDER);
    }
    widgets.noninteractive.bg_fill = CARD;
    widgets.noninteractive.weak_bg_fill = CARD;
    widgets.inactive.bg_fill = SURFACE;
    widgets.inactive.weak_bg_fill = SURFACE;
    widgets.hovered.bg_fill = HOVERED;
    widgets.hovered.weak_bg_fill = HOVERED;
    widgets.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(62, 62, 68));
    widgets.active.bg_fill = SELECTED;
    widgets.active.weak_bg_fill = SELECTED;
    widgets.active.bg_stroke = Stroke::new(1.0, ACCENT);
    widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    widgets.open.bg_fill = SELECTED;
    widgets.open.weak_bg_fill = SELECTED;
    widgets.open.bg_stroke = Stroke::new(1.0, ACCENT);

    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.button_padding = egui::vec2(12.0, 6.0);
    style.spacing.interact_size.y = 30.0;
    style.spacing.window_margin = egui::Margin::same(22);
    style.spacing.menu_margin = egui::Margin::same(8);
    style.spacing.extra_text_line_spacing = 1.0;
    style.spacing.icon_width = 16.0;
    style.spacing.icon_width_inner = 10.0;
    style.spacing.icon_spacing = 8.0;
    style.spacing.scroll.bar_width = 7.0;
    style.spacing.scroll.floating_width = 3.0;
    style.spacing.scroll.floating_allocated_width = 4.0;
    style.spacing.scroll.handle_min_length = 28.0;
    style.spacing.scroll.dormant_handle_opacity = 0.25;
    style.spacing.scroll.active_handle_opacity = 0.55;
    style.spacing.scroll.interact_handle_opacity = 0.85;
    style
        .text_styles
        .insert(TextStyle::Body, FontId::proportional(13.0));
    style.text_styles.insert(TextStyle::Button, medium(13.0));
    style.text_styles.insert(TextStyle::Heading, semibold(19.0));
    style
        .text_styles
        .insert(TextStyle::Small, FontId::proportional(11.0));
    style
        .text_styles
        .insert(TextStyle::Monospace, FontId::monospace(12.0));
    style.url_in_tooltip = true;
    ctx.set_theme(egui::Theme::Dark);
    ctx.set_style_of(egui::Theme::Dark, style);
}

fn apply_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    for (name, bytes) in [
        (
            "Inter",
            include_bytes!("../assets/fonts/Inter-Regular.ttf").as_slice(),
        ),
        (
            "Inter Medium",
            include_bytes!("../assets/fonts/Inter-Medium.ttf").as_slice(),
        ),
        (
            "Inter Semibold",
            include_bytes!("../assets/fonts/Inter-SemiBold.ttf").as_slice(),
        ),
    ] {
        fonts
            .font_data
            .insert(name.into(), egui::FontData::from_static(bytes).into());
        let mut fallbacks = fonts.families[&egui::FontFamily::Proportional].clone();
        fallbacks.insert(0, name.into());
        fonts
            .families
            .insert(egui::FontFamily::Name(name.into()), fallbacks);
    }
    fonts
        .families
        .get_mut(&egui::FontFamily::Proportional)
        .expect("default proportional family")
        .insert(0, "Inter".into());
    ctx.set_fonts(fonts);
}

pub(crate) fn medium(size: f32) -> FontId {
    FontId::new(size, egui::FontFamily::Name("Inter Medium".into()))
}

pub(crate) fn semibold(size: f32) -> FontId {
    FontId::new(size, egui::FontFamily::Name("Inter Semibold".into()))
}

pub(crate) fn primary_button(label: impl Into<String>) -> egui::Button<'static> {
    egui::Button::new(RichText::new(label).font(medium(13.0)).color(PRIMARY_TEXT))
        .fill(ACCENT_FILL)
        .corner_radius(5)
        .min_size(egui::vec2(0.0, 30.0))
}

pub(crate) fn card() -> egui::Frame {
    egui::Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0, BORDER))
        .corner_radius(7)
        .inner_margin(16)
}

/// Reusable hierarchy for native pages and dialogs. No effects or retained state.
pub(crate) fn page_intro(ui: &mut egui::Ui, title: &str, description: &str) {
    ui.label(RichText::new(title).font(semibold(22.0)));
    if !description.is_empty() {
        ui.add_space(4.0);
        ui.add(egui::Label::new(RichText::new(description).color(MUTED)).wrap());
    }
    ui.add_space(16.0);
}

pub(crate) fn section<R>(
    ui: &mut egui::Ui,
    title: &str,
    description: &str,
    contents: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let width = ui.available_width();
    let result = card()
        .show(ui, |ui| {
            ui.set_width((width - 34.0).max(0.0));
            ui.label(RichText::new(title).font(semibold(14.0)));
            if !description.is_empty() {
                ui.add(egui::Label::new(RichText::new(description).small().color(MUTED)).wrap());
            }
            ui.add_space(8.0);
            contents(ui)
        })
        .inner;
    ui.add_space(12.0);
    result
}

pub(crate) fn field_label(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.label(RichText::new(label).text_style(TextStyle::Button))
}

pub(crate) fn suggestion(ui: &mut egui::Ui, title: &str) -> egui::Response {
    let response = ui.add_sized(
        [ui.available_width().min(540.0), 42.0],
        egui::Button::new(RichText::new(title).font(medium(13.0)))
            .right_text("→")
            .fill(CARD)
            .stroke(Stroke::new(1.0, BORDER)),
    );
    response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, title));
    response
}

#[derive(Clone, Copy)]
pub(crate) enum NavIcon {
    Conversation,
    Agent,
    Environment,
    Vault,
}

pub(crate) fn navigation_button(
    ui: &mut egui::Ui,
    label: &str,
    selected: bool,
    icon: NavIcon,
) -> egui::Response {
    let response = ui.add_sized(
        [ui.available_width(), 32.0],
        egui::Button::new(
            RichText::new(format!("      {label}"))
                .font(medium(13.0))
                .color(if selected { TEXT } else { MUTED }),
        )
        .right_text("")
        .selected(selected)
        .frame_when_inactive(selected)
        .stroke(Stroke::NONE),
    );
    response.widget_info(|| egui::WidgetInfo::selected(egui::Role::Button, true, selected, label));
    let origin = egui::pos2(response.rect.left() + 10.0, response.rect.center().y - 7.0);
    let stroke = Stroke::new(1.2, if selected { TEXT } else { MUTED });
    let point = |x, y| origin + egui::vec2(x, y);
    let line = |a: (f32, f32), b: (f32, f32)| {
        ui.painter()
            .line_segment([point(a.0, a.1), point(b.0, b.1)], stroke);
    };
    match icon {
        NavIcon::Conversation => {
            ui.painter().rect_stroke(
                egui::Rect::from_min_max(point(0.0, 0.0), point(14.0, 10.0)),
                2,
                stroke,
                egui::StrokeKind::Inside,
            );
            line((3.0, 10.0), (3.0, 14.0));
            line((3.0, 14.0), (7.0, 10.0));
        }
        NavIcon::Agent => {
            ui.painter().circle_stroke(point(7.0, 4.0), 3.0, stroke);
            ui.painter().add(egui::Shape::line(
                vec![
                    point(1.0, 14.0),
                    point(1.0, 12.0),
                    point(4.0, 9.0),
                    point(10.0, 9.0),
                    point(13.0, 12.0),
                    point(13.0, 14.0),
                ],
                stroke,
            ));
        }
        NavIcon::Environment => {
            ui.painter().rect_stroke(
                egui::Rect::from_min_max(point(0.0, 1.0), point(14.0, 13.0)),
                2,
                stroke,
                egui::StrokeKind::Inside,
            );
            line((0.0, 5.0), (14.0, 5.0));
            line((4.0, 8.0), (6.0, 10.0));
            line((6.0, 10.0), (4.0, 12.0));
            line((8.0, 11.0), (11.0, 11.0));
        }
        NavIcon::Vault => {
            ui.painter().rect_stroke(
                egui::Rect::from_min_max(point(1.0, 5.0), point(13.0, 14.0)),
                2,
                stroke,
                egui::StrokeKind::Inside,
            );
            ui.painter().add(egui::Shape::line(
                vec![
                    point(4.0, 5.0),
                    point(4.0, 1.0),
                    point(10.0, 1.0),
                    point(10.0, 5.0),
                ],
                stroke,
            ));
            line((7.0, 8.0), (7.0, 11.0));
        }
    }
    response
}

pub(crate) fn status(ui: &mut egui::Ui, status: &str) {
    if status.is_empty() {
        return;
    }
    let color = match status {
        "failed" | "error" | "disconnected" => ERROR,
        "in_progress" => ACCENT,
        "queued" | "waiting" | "requires_action" => WARNING,
        "ready" | "active" | "completed" | "connected" => SUCCESS,
        _ => MUTED,
    };
    egui::Frame::new()
        .fill(CARD)
        .corner_radius(4)
        .inner_margin(egui::Margin::symmetric(8, 4))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(egui::vec2(6.0, 6.0), egui::Sense::hover());
                ui.painter().circle_filled(rect.center(), 3.0, color);
                ui.label(
                    RichText::new(match status {
                        "idle" => "Ready".into(),
                        "in_progress" => "Working".into(),
                        "requires_action" => "Needs input".into(),
                        other => other.replace('_', " "),
                    })
                    .size(12.0)
                    .color(TEXT),
                );
            });
        });
}

// Semantic identity colors, mirrored in site/brand.css and session-collaboration-planning.ts.
pub(crate) const PARTICIPANT_COLORS: [Color32; 8] = [
    Color32::from_rgb(217, 173, 245),
    Color32::from_rgb(143, 201, 255),
    Color32::from_rgb(243, 199, 123),
    Color32::from_rgb(242, 169, 194),
    Color32::from_rgb(184, 206, 145),
    Color32::from_rgb(196, 185, 255),
    Color32::from_rgb(239, 167, 139),
    Color32::from_rgb(154, 205, 221),
];
pub(crate) fn participant_color(value: &str) -> Color32 {
    let Some(hex) = value
        .strip_prefix('#')
        .filter(|hex| hex.len() == 6 && hex.is_ascii())
    else {
        return MUTED;
    };
    let Ok(rgb) = u32::from_str_radix(hex, 16) else {
        return MUTED;
    };
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}
