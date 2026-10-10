use crate::{app::LOADING_FEEDBACK_DELAY, model::Resource, theme};
use egui::{RichText, Ui};
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Default)]
pub(crate) struct EnvironmentPicker {
    pub templates: Option<Vec<Resource>>,
    pub started: Option<Instant>,
    pub error: Option<String>,
    pub refresh_requested: bool,
}

impl EnvironmentPicker {
    pub fn field(&mut self, ui: &mut Ui, editor_id: u64, value: &mut Value) -> bool {
        let environment = value.get("environment").cloned().unwrap_or(Value::Null);
        let template_id = environment
            .get("environment_template_id")
            .and_then(Value::as_str);
        let templates = self.templates.as_deref().unwrap_or_default();
        let is_none = environment.get("type").and_then(Value::as_str) == Some("none");
        let current_name = if is_none {
            "No environment"
        } else if let Some(id) = template_id {
            templates
                .iter()
                .find(|template| template.id == id)
                .map(Resource::title)
                .unwrap_or(id)
        } else {
            "Custom environment (Advanced JSON)"
        };
        let label = ui
            .horizontal(|ui| {
                let label = ui.label(RichText::new("Environment").strong());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(
                            self.started.is_none(),
                            egui::Button::new(if self.error.is_some() {
                                "Retry templates"
                            } else {
                                "Refresh templates"
                            })
                            .small(),
                        )
                        .clicked()
                    {
                        self.refresh_requested = true;
                    }
                });
                label
            })
            .inner;
        let mut choice = None;
        let response = egui::ComboBox::from_id_salt(("environment-picker", editor_id))
            .selected_text(current_name)
            .width(ui.available_width())
            .truncate()
            .show_ui(ui, |ui| {
                ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Truncate);
                if ui.selectable_label(is_none, "No environment").clicked() {
                    choice = Some(None);
                }
                for template in templates {
                    if ui
                        .selectable_label(
                            template_id == Some(template.id.as_str()),
                            template.title(),
                        )
                        .on_hover_text(&template.id)
                        .clicked()
                    {
                        choice = Some(Some(template.id.clone()));
                    }
                }
            })
            .response
            .labelled_by(label.id);
        response.widget_info(|| {
            egui::WidgetInfo::labeled(egui::WidgetType::ComboBox, true, "Environment")
        });
        if self
            .started
            .is_some_and(|started| started.elapsed() >= LOADING_FEEDBACK_DELAY)
        {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(
                    RichText::new("Loading environment templates…")
                        .small()
                        .color(theme::MUTED),
                );
            });
        } else if let Some(error) = &self.error {
            ui.colored_label(theme::ERROR, "Could not load environment templates.")
                .on_hover_text(error);
        } else if self.templates.is_some() && templates.is_empty() {
            ui.label(
                RichText::new("No templates yet. Create one in Templates.")
                    .small()
                    .color(theme::MUTED),
            );
        }
        if let Some(id) = template_id
            && self.templates.is_some()
            && !templates.iter().any(|template| template.id == id)
        {
            ui.colored_label(
                theme::ERROR,
                "This template is not in the available list. Refresh or choose another.",
            );
        }
        let Some(choice) = choice else { return false };
        let next = match choice {
            None => json!({"type":"none"}),
            Some(id) => {
                // Keep compatible inline overrides supplied through Advanced JSON.
                let mut next =
                    if environment.get("type").and_then(Value::as_str) == Some("openai_hosted") {
                        environment.clone()
                    } else {
                        json!({"type":"openai_hosted"})
                    };
                next["environment_template_id"] = id.into();
                next
            }
        };
        if next == environment {
            return false;
        }
        value["environment"] = next;
        true
    }
}
