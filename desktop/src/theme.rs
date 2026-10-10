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

pub(crate) fn status(ui: &mut egui::Ui, status: &str) {
    if status.is_empty() {
        return;
    }
    let (color, background) = match status {
        "failed" | "error" | "disconnected" => (ERROR, Color32::from_rgb(55, 37, 35)),
        "in_progress" => (ACCENT, SELECTED),
        "queued" | "waiting" | "requires_action" => (WARNING, Color32::from_rgb(51, 45, 33)),
        "ready" | "active" | "completed" | "connected" => (SUCCESS, Color32::from_rgb(37, 47, 38)),
        _ => (MUTED, SURFACE),
    };
    egui::Frame::new()
        .fill(background)
        .corner_radius(4)
        .inner_margin(egui::Margin::symmetric(8, 4))
        .show(ui, |ui| {
            ui.label(
                RichText::new(match status {
                    "idle" => "Ready".into(),
                    "in_progress" => "Working".into(),
                    "requires_action" => "Needs input".into(),
                    other => other.replace('_', " "),
                })
                .size(12.0)
                .color(color),
            );
        });
}
