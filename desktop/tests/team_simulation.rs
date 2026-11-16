//! Opt-in native UI bridge for independent collaborator agents. No API shortcuts.
use egui::{Event, Key, Modifiers, PointerButton, Vec2};
use egui_kittest::{
    Harness,
    kittest::{NodeT, Queryable},
};
use rat_things_desktop::ConsoleApp;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

type App = Harness<'static, ConsoleApp>;
fn step(app: &mut App) {
    app.run_steps(3);
}
fn named(app: &mut App, label: &str, index: usize, fill: Option<&str>) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        step(app);
        if app
            .query_all_by_label(label)
            .nth(index)
            .is_some_and(|n| !n.accesskit_node().is_disabled())
        {
            break;
        }
        if Instant::now() >= deadline {
            return Err(format!("Control unavailable: {label} (index {index})"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    app.query_all_by_label(label)
        .nth(index)
        .unwrap()
        .scroll_to_me();
    step(app);
    if let Some(text) = fill {
        app.query_all_by_label(label)
            .nth(index)
            .ok_or("Control moved")?
            .focus();
        step(app);
        app.key_press_modifiers(Modifiers::COMMAND, Key::A);
        app.key_press(Key::Backspace);
        step(app);
        // A word at a time exercises the actual typing signal, without API injection.
        for word in text.split_inclusive(' ') {
            app.query_all_by_label(label)
                .nth(index)
                .ok_or("Control moved")?
                .type_text(word);
            step(app);
            std::thread::sleep(Duration::from_millis(35));
        }
    } else {
        app.query_all_by_label(label)
            .nth(index)
            .ok_or("Control moved")?
            .click();
    }
    step(app);
    Ok(())
}
fn pointer(app: &mut App, pos: egui::Pos2, down: bool) {
    app.event(Event::PointerMoved(pos));
    app.event(Event::PointerButton {
        pos,
        button: PointerButton::Primary,
        pressed: down,
        modifiers: Modifiers::default(),
    });
    step(app);
}
fn act(app: &mut App, request: &Value) -> Result<(), String> {
    let label = request["label"].as_str().unwrap_or("");
    let index = request["index"].as_u64().unwrap_or(0) as usize;
    match request["op"].as_str().unwrap_or("inspect") {
        "inspect" => {}
        "click" => named(app, label, index, None)?,
        "fill" => named(
            app,
            label,
            index,
            Some(request["text"].as_str().ok_or("text is required")?),
        )?,
        "say" => {
            named(
                app,
                "Message",
                0,
                Some(request["text"].as_str().ok_or("text is required")?),
            )?;
            let label = if app.query_by_label("Send").is_some() {
                "Send"
            } else {
                "Steer"
            };
            named(app, label, 0, None)?;
        }
        "press" => {
            let key = match request["key"].as_str().unwrap_or("") {
                "Escape" => Key::Escape,
                "Enter" => Key::Enter,
                "Tab" => Key::Tab,
                _ => return Err("Supported keys: Escape, Enter, Tab".into()),
            };
            app.key_press(key);
            step(app);
        }
        "point" | "region" => {
            let rect = app
                .query_all_by_role(egui::accesskit::Role::Image)
                .map(|n| n.rect())
                .max_by(|a, b| a.area().total_cmp(&b.area()))
                .ok_or("No preview image is visible")?;
            let point = |key: &str| -> Result<egui::Pos2, String> {
                let x = request[key][0]
                    .as_f64()
                    .ok_or("Expected normalized [x,y]")? as f32;
                let y = request[key][1]
                    .as_f64()
                    .ok_or("Expected normalized [x,y]")? as f32;
                if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                    return Err("Point must be inside the image".into());
                }
                Ok(rect.min + Vec2::new(rect.width() * x, rect.height() * y))
            };
            let from = point("at")?;
            pointer(app, from, true);
            let to = if request["op"] == "region" {
                point("to")?
            } else {
                from
            };
            app.event(Event::PointerMoved(to));
            step(app);
            pointer(app, to, false);
        }
        "resize" => {
            let width = request["width"].as_f64().ok_or("width is required")? as f32;
            let height = request["height"].as_f64().ok_or("height is required")? as f32;
            if !(700.0..=1600.0).contains(&width) || !(550.0..=1000.0).contains(&height) {
                return Err("Viewport is out of bounds".into());
            }
            app.set_size(Vec2::new(width, height));
            step(app);
        }
        _ => return Err("Unknown UI operation".into()),
    }
    Ok(())
}
fn capture(app: &mut App, directory: &Path, id: &str, result: Result<(), String>, elapsed: u128) {
    step(app);
    let image = directory.join(format!("{id}.png"));
    app.render().unwrap().save(&image).unwrap();
    let nodes: Vec<_> = app.root().children_recursive().filter_map(|n| {
        let access=n.accesskit_node(); let role=format!("{:?}",access.role());
        let label=access.label(); let value=n.value();
        if label.is_none() && value.is_none() && role!="Image" { return None; }
        if role=="TextRun" { return None; }
        let rect=n.rect();
        Some(json!({"role":role,"label":label,"value":value,"disabled":access.is_disabled(),"rect":[rect.min.x,rect.min.y,rect.max.x,rect.max.y]}))
    }).collect();
    let response = json!({"ok":result.is_ok() && !app.state().workspace_action_pending() && !app.state().message_submission_pending(),"error":result.err(),"elapsed_ms":elapsed,
        "pending":app.state().workspace_action_pending() || app.state().message_submission_pending(),"screenshot":image,"nodes":nodes});
    std::fs::write(
        directory.join(format!("{id}.result.json")),
        serde_json::to_vec_pretty(&response).unwrap(),
    )
    .unwrap();
}
#[test]
#[ignore = "Four native clients against a bounded local subscription simulation"]
fn drive_team_simulation() {
    assert_eq!(std::env::var("RAT_TEAM_SIMULATION").as_deref(), Ok("true"));
    let connection: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("RAT_AGENTS_LIVE_CONNECTION").unwrap()).unwrap(),
    )
    .unwrap();
    let output = PathBuf::from(std::env::var("RAT_TEAM_SIMULATION_UI").unwrap());
    std::fs::create_dir_all(&output).unwrap();
    let names: Vec<String> = match std::env::var("RAT_TEAM_PARTICIPANT") {
        Ok(name) => {
            assert!(["client", "designer", "engineer", "qa"].contains(&name.as_str()));
            vec![name]
        }
        Err(_) => ["client", "designer", "engineer", "qa"]
            .map(str::to_owned)
            .to_vec(),
    };
    let mut apps: Vec<App> = names
        .iter()
        .map(|name| {
            let url = connection["url"].as_str().unwrap().to_owned();
            let token = connection["participants"][name.as_str()]["token"]
                .as_str()
                .unwrap()
                .to_owned();
            Harness::builder()
                .with_step_dt(1.0 / 60.0)
                // Generated artifacts may contain arbitrary Unicode. Match the
                // production fallback instead of aborting the whole participant.
                .allow_missing_glyphs()
                .with_size(Vec2::new(1280.0, 850.0))
                .build_eframe(move |_| ConsoleApp::new(url, token).unwrap())
        })
        .collect();
    for (i, app) in apps.iter_mut().enumerate() {
        let directory = output.join(&names[i]);
        std::fs::create_dir_all(directory.join("requests")).unwrap();
        named(app, connection["title"].as_str().unwrap(), 0, None).unwrap();
        capture(app, &directory, "initial", Ok(()), 0);
    }
    std::fs::write(output.join(format!("ready-{}", names.join("-"))), "ready").unwrap();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(45 * 60) && !output.join("stop").exists() {
        for (i, app) in apps.iter_mut().enumerate() {
            step(app);
            let directory = output.join(&names[i]);
            let mut queue: Vec<_> = std::fs::read_dir(directory.join("requests"))
                .unwrap()
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect();
            queue.sort();
            for path in queue {
                let id = path.file_stem().unwrap().to_str().unwrap();
                let request: Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let before = Instant::now();
                let previous = app
                    .state()
                    .workspace_action_result()
                    .map(|outcome| outcome.0);
                let previous_message = app
                    .state()
                    .message_submission_result()
                    .map(|outcome| outcome.0);
                let mut result = act(app, &request);
                // A dispatched click is not a settled browser response. Preserve the
                // timeout as an explicit pending outcome rather than a false success.
                let deadline = Instant::now() + Duration::from_secs(10);
                while result.is_ok()
                    && (app.state().workspace_action_pending()
                        || app.state().message_submission_pending())
                    && Instant::now() < deadline
                {
                    step(app);
                    std::thread::sleep(Duration::from_millis(25));
                }
                if result.is_ok()
                    && let Some((completed, Some(error))) = app.state().workspace_action_result()
                    && Some(completed) != previous
                {
                    result = Err(error);
                }
                if result.is_ok()
                    && let Some((completed, Some(error))) = app.state().message_submission_result()
                    && Some(completed) != previous_message
                {
                    result = Err(error);
                }
                capture(app, &directory, id, result, before.elapsed().as_millis());
                std::fs::rename(&path, directory.join(format!("{id}.request.json"))).unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
