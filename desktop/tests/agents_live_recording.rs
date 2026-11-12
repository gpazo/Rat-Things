//! Opt-in observer recording of two AI participants in a live local Session.
//!
//! Start `testing/shared-workspace/agents-live/server.ts` first. Each native client
//! signs in as one participant and only watches; contributions arrive through the API.
//! Write `conversation`, `browser` or `stop` to `<output>/control` to direct the views.
use egui::Vec2;
use egui_kittest::{
    Harness,
    kittest::{NodeT, Queryable},
};
use image::{
    ImageEncoder,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use rat_things_desktop::ConsoleApp;
use serde_json::{Value, json};
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    path::PathBuf,
    time::{Duration, Instant},
};

type App = Harness<'static, ConsoleApp>;

fn click(app: &mut App, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while app
        .query_by_label(label)
        .is_none_or(|node| node.accesskit_node().is_disabled())
    {
        app.run_steps(2);
        std::thread::sleep(Duration::from_millis(100));
        assert!(Instant::now() < deadline, "Waiting for {label}");
    }
    app.get_by_label(label).scroll_to_me();
    app.run_steps(2);
    app.get_by_label(label).click();
    app.run_steps(2);
}

#[test]
#[ignore = "Observes a live local Session started by agents-live/server.ts"]
fn record_agents_live_session() {
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let directory = std::env::var("RAT_THINGS_LOCAL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".rat-things/multiplayer-demo"));
    let connection: Value =
        serde_json::from_slice(&std::fs::read(directory.join("agents-live.json")).unwrap())
            .unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = root.join("test-results/agents-live");
    std::fs::create_dir_all(&output).unwrap();
    let control = output.join("control");
    std::fs::write(&control, "conversation").unwrap();
    let names = ["claude", "codex"];
    let mut apps: Vec<App> = names
        .iter()
        .map(|name| {
            let token = connection["participants"][name]["token"]
                .as_str()
                .unwrap()
                .to_owned();
            let url = connection["url"].as_str().unwrap().to_owned();
            Harness::builder()
                .with_size(Vec2::new(1280.0, 800.0))
                .with_pixels_per_point(2.0)
                .build_eframe(move |_| ConsoleApp::new(url, token).unwrap())
        })
        .collect();
    let title = connection["title"].as_str().unwrap();
    for app in &mut apps {
        click(app, title);
    }
    let mut frames: Vec<Value> = vec![];
    let mut last_hash = [0_u64; 2];
    let mut view = String::from("conversation");
    let started = Instant::now();
    loop {
        let tick = Instant::now();
        let requested = std::fs::read_to_string(&control)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if requested == "stop" {
            break;
        }
        if requested != view {
            for app in &mut apps {
                match requested.as_str() {
                    "browser" => {
                        click(app, "Shared workspace");
                        click(app, "Live browser");
                    }
                    "conversation" => click(app, "← Conversation"),
                    _ => {}
                }
            }
            view = requested;
        }
        for app in &mut apps {
            app.run_steps(2);
        }
        let mut changed = vec![];
        for (index, app) in apps.iter_mut().enumerate() {
            let frame = app.render().expect("render native client");
            let mut hasher = DefaultHasher::new();
            frame.as_raw().hash(&mut hasher);
            let hash = hasher.finish();
            if hash == last_hash[index] {
                continue;
            }
            last_hash[index] = hash;
            let file = format!("{:05}-{}.png", frames.len(), names[index]);
            PngEncoder::new_with_quality(
                std::io::BufWriter::new(std::fs::File::create(output.join(&file)).unwrap()),
                CompressionType::Fast,
                FilterType::Sub,
            )
            .write_image(
                frame.as_raw(),
                frame.width(),
                frame.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
            changed.push(json!({"participant": names[index], "file": file}));
        }
        if !changed.is_empty() {
            let typing: Vec<String> = apps
                .iter()
                .map(|app| {
                    app.query_all_by_label_contains("typing")
                        .filter_map(|node| node.accesskit_node().label())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect();
            frames.push(json!({"elapsed_ms": started.elapsed().as_millis(), "view": view, "changed": changed, "typing": typing}));
            std::fs::write(
                output.join("frames.json"),
                serde_json::to_vec(&frames).unwrap(),
            )
            .unwrap();
        }
        std::thread::sleep(Duration::from_millis(250).saturating_sub(tick.elapsed()));
    }
}
