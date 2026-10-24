mod harness;
pub use harness::*;

use egui_kittest::kittest::Queryable;
use serde_json::Value;

pub fn advanced_json(app: &mut App) {
    if app.query_by_label("Configuration JSON").is_none() {
        click(app, "Advanced JSON");
    }
    visible(app, "Configuration JSON");
}

pub fn editor(app: &mut App, value: Value, submit: &str) {
    advanced_json(app);
    fill(
        app,
        "Configuration JSON",
        &serde_json::to_string_pretty(&value).unwrap(),
    );
    click(app, submit);
    until(app, "editor to close after persistence", |app| {
        app.query_by_label("Configuration JSON").is_none()
    });
}
