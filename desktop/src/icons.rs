//! Pinned Phosphor regular glyphs; labels remain available to assistive technology.
use crate::theme;
use egui::{FontFamily, FontId, Response, RichText, Ui};

#[derive(Clone, Copy)]
pub(crate) enum Icon {
    Back,
    Forward,
    Reply,
    Expand,
    Collapse,
    ZoomIn,
    ZoomOut,
    Fit,
    Copy,
    Close,
    Attach,
    SelectText,
    Comment,
    History,
    Refresh,
    File,
    Image,
    Annotate,
    Stop,
    Agent,
    Environment,
    Vault,
    More,
    Info,
    Files,
    ChevronRight,
    ChevronDown,
    Keyboard,
    Up,
    Down,
    Phone,
    Desktop,
}

impl Icon {
    pub(crate) fn glyph(self) -> &'static str {
        match self {
            Self::Back => "\u{e058}",
            Self::Forward => "\u{e06c}",
            Self::Reply => "\u{e024}",
            Self::Expand => "\u{e0a6}",
            Self::Collapse => "\u{e09e}",
            Self::ZoomIn => "\u{e310}",
            Self::ZoomOut => "\u{e30e}",
            Self::Fit => "\u{e626}",
            Self::Copy => "\u{e1ca}",
            Self::Close => "\u{e4f6}",
            Self::Attach => "\u{e39a}",
            Self::SelectText => "\u{e7d8}",
            Self::Comment => "\u{e168}",
            Self::History => "\u{e1a0}",
            Self::Refresh => "\u{e036}",
            Self::File => "\u{e230}",
            Self::Image => "\u{e2ca}",
            Self::Annotate => "\u{e3b4}",
            Self::Stop => "\u{e46c}",
            Self::Agent => "\u{e762}",
            Self::Environment => "\u{eae8}",
            Self::Vault => "\u{e2fe}",
            Self::More => "\u{e1fe}",
            Self::Info => "\u{e2ce}",
            Self::Files => "\u{e256}",
            Self::ChevronRight => "\u{e13a}",
            Self::ChevronDown => "\u{e136}",
            Self::Keyboard => "\u{e2d8}",
            Self::Up => "\u{e08e}",
            Self::Down => "\u{e03e}",
            Self::Phone => "\u{e1e0}",
            Self::Desktop => "\u{e560}",
        }
    }
}

pub(crate) fn install(fonts: &mut egui::FontDefinitions) {
    fonts.font_data.insert(
        "Phosphor".into(),
        egui::FontData::from_static(include_bytes!("../assets/icons/Phosphor-Regular.ttf")).into(),
    );
    fonts
        .families
        .insert(FontFamily::Name("Phosphor".into()), vec!["Phosphor".into()]);
}

pub(crate) fn font(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name("Phosphor".into()))
}

pub(crate) fn button(ui: &mut Ui, icon: Icon, label: &str) -> Response {
    button_enabled(ui, true, icon, label)
}

pub(crate) fn button_enabled(ui: &mut Ui, enabled: bool, icon: Icon, label: &str) -> Response {
    action_button(ui, enabled, None, true, icon, label)
}

pub(crate) fn toolbar_button(
    ui: &mut Ui,
    enabled: bool,
    selected: Option<bool>,
    icon: Icon,
    label: &str,
) -> Response {
    action_button(ui, enabled, selected, false, icon, label)
}

fn action_button(
    ui: &mut Ui,
    enabled: bool,
    selected: Option<bool>,
    framed: bool,
    icon: Icon,
    label: &str,
) -> Response {
    let response = ui
        .scope(|ui| {
            ui.spacing_mut().button_padding = egui::vec2(6.0, 6.0);
            let mut button = egui::Button::new(RichText::new(icon.glyph()).font(font(18.0)))
                .frame(framed || selected == Some(true))
                .min_size(egui::vec2(30.0, 30.0));
            if let Some(selected) = selected {
                button = button.selected(selected);
            }
            ui.add_enabled(enabled, button)
        })
        .inner;
    response.widget_info(|| match selected {
        Some(selected) => {
            egui::WidgetInfo::selected(egui::Role::Button, response.enabled(), selected, label)
        }
        None => egui::WidgetInfo::labeled(egui::Role::Button, response.enabled(), label),
    });
    response.on_hover_text(label)
}

/// A recognizable object is its own action: the file or source title is the link.
pub(crate) fn object_button(ui: &mut Ui, icon: Icon, title: &str, label: &str) -> Response {
    let response = ui.add(
        egui::Button::new(text(icon, title))
            .truncate()
            .min_size(egui::vec2(0.0, 30.0)),
    );
    response
        .widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, response.enabled(), label));
    response.on_hover_text(label)
}

pub(crate) fn text(icon: Icon, title: &str) -> egui::text::LayoutJob {
    let mut text = egui::text::LayoutJob::default();
    text.append(
        icon.glyph(),
        0.0,
        egui::TextFormat {
            font_id: font(18.0),
            color: theme::TEXT,
            ..Default::default()
        },
    );
    text.append(
        title,
        6.0,
        egui::TextFormat {
            font_id: theme::medium(13.0),
            color: theme::TEXT,
            ..Default::default()
        },
    );
    text
}

pub(crate) fn menu<R>(
    ui: &mut Ui,
    icon: Icon,
    label: &str,
    contents: impl FnOnce(&mut Ui) -> R,
) -> Response {
    let response = ui
        .scope(|ui| {
            ui.spacing_mut().button_padding = egui::vec2(6.0, 6.0);
            ui.menu_button(RichText::new(icon.glyph()).font(font(18.0)), contents)
                .response
        })
        .inner;
    response
        .widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, response.enabled(), label));
    response.on_hover_text(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui_kittest::{
        Harness,
        kittest::{NodeT, Queryable},
    };

    #[test]
    fn compact_actions_keep_names_focus_activation_and_disabled_state() {
        let mut app = Harness::new_ui_state(
            |ui, clicked: &mut usize| {
                theme::apply(ui.ctx());
                ui.horizontal(|ui| {
                    if button(ui, Icon::Copy, "Copy message").clicked() {
                        *clicked += 1;
                    }
                    if button_enabled(ui, false, Icon::Stop, "Cancel turn").clicked() {
                        *clicked += 100;
                    }
                    object_button(
                        ui,
                        Icon::Image,
                        "Product direction",
                        "View attachment · Product direction",
                    );
                });
            },
            0_usize,
        );
        app.run_steps(3);
        let copy = app.get_by_label("Copy message");
        assert!(copy.rect().width() >= 30.0 && copy.rect().height() >= 30.0);
        assert!(
            copy.rect().width() <= 34.0,
            "An icon action should not reserve its accessible label's width"
        );
        copy.focus();
        app.run_steps(2);
        app.key_press(egui::Key::Enter);
        app.run_steps(3);
        assert_eq!(*app.state(), 1);
        assert!(
            app.get_by_label("Cancel turn")
                .accesskit_node()
                .is_disabled()
        );
        assert!(
            app.query_by_label("View attachment · Product direction")
                .is_some()
        );
    }
}
