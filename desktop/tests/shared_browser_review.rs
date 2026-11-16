//! Real local Linux browser and two native clients, with deterministic model responses.
#[allow(dead_code)]
mod support;
use egui::{Event, Modifiers, PointerButton, Vec2, accesskit::Role};
use egui_kittest::{
    Harness,
    kittest::{NodeT, Queryable},
};
use rat_things_desktop::ConsoleApp;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use support::*;

#[test]
#[ignore = "Starts a local Linux worker; no paid inference"]
fn teammates_review_one_page_at_phone_and_desktop_sizes() {
    assert_eq!(std::env::var("RAT_BROWSER_REVIEW").as_deref(), Ok("true"));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = std::env::var_os("RAT_BROWSER_REVIEW_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("artifacts/shared-workspace/taco-refinement"));
    std::fs::create_dir_all(&output).unwrap();
    for name in ["evidence.json", "cleanup.json"] {
        let _ = std::fs::remove_file(output.join(name));
    }
    let control = uuid::Uuid::new_v4().to_string();
    let document = root.join("artifacts/shared-workspace/taco-team-simulation/index.html");
    let mut server = Server::spawn(
        &root,
        "testing/shared-workspace/demo-server.ts",
        &[
            ("RAT_SHARED_WORKSPACE_DEMO", "true"),
            ("RAT_DEMO_CONTROL", &control),
            ("RAT_DEMO_DOCUMENT", document.to_str().unwrap()),
            ("RAT_DEMO_OUTPUT", output.to_str().unwrap()),
        ],
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let config: Value = client
        .get(format!("{}/demo/config", server.url))
        .header("x-demo-control", control)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    let token = config["people"][0]["token"].as_str().unwrap();
    let path = format!(
        "{}/api/v1/rat/sessions/{}/workspace/browser",
        server.url,
        config["sessionId"].as_str().unwrap()
    );
    let frame = || -> Value {
        client
            .get(&path)
            .bearer_auth(token)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    };
    let mut apps: Vec<App> = config["people"].as_array().unwrap()[..2]
        .iter()
        .map(|p| {
            Harness::builder()
                .with_step_dt(1.0 / 60.0)
                .allow_missing_glyphs()
                .with_size(Vec2::new(1440.0, 950.0))
                .build_eframe(|_| {
                    ConsoleApp::new(server.url.clone(), p["token"].as_str().unwrap().into())
                        .unwrap()
                })
        })
        .collect();
    for app in &mut apps {
        click(app, "Works on our machines");
        until(app, "browser frame", |a| {
            a.query_by_label("Phone viewport")
                .is_some_and(|n| !n.accesskit_node().is_disabled())
        });
    }
    let image_rect = |app: &App| {
        app.query_all_by_role(Role::Image)
            .map(|n| n.rect())
            .max_by(|a, b| a.area().total_cmp(&b.area()))
            .unwrap()
    };
    let save = |app: &mut App, name: &str| {
        app.remove_cursor();
        app.run_steps(3);
        app.render().unwrap().save(output.join(name)).unwrap();
    };
    save(&mut apps[0], "desktop.png");
    click(&mut apps[0], "Phone viewport");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while frame()["width"] != 390 && std::time::Instant::now() < deadline {
        tick(&mut apps[0]);
    }
    if frame()["width"] != 390 {
        save(&mut apps[0], "resize-failure.png");
        let evidence: Value = client
            .get(format!("{}/api/v1/demo/evidence", server.url))
            .bearer_auth(token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        std::fs::write(
            output.join("resize-failure.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        std::fs::write(
            output.join("resize-failure-ui.txt"),
            format!("{:#?}", apps[0].root()),
        )
        .unwrap();
        panic!("Phone resize failed; inspect resize-failure evidence");
    }
    until(&mut apps[1], "second client phone frame", |a| {
        let r = image_rect(a);
        (r.width() / r.height() - 390.0 / 844.0).abs() < 0.01
    });
    until(&mut apps[0], "first client phone frame", |a| {
        let r = image_rect(a);
        (r.width() / r.height() - 390.0 / 844.0).abs() < 0.01
    });
    save(&mut apps[0], "phone-first.png");
    save(&mut apps[1], "phone-second.png");
    assert!(
        apps[1]
            .query_by_label("Shared · Phone · 390 × 844")
            .is_some()
    );
    assert!(apps[1].query_by_label_contains("resized").is_some());
    click(&mut apps[0], "Actual size");
    assert!((image_rect(&apps[0]).width() - 390.0).abs() < 1.0);
    save(&mut apps[0], "phone-actual-size.png");
    click(&mut apps[0], "Reset zoom");
    let phone = frame();
    assert_eq!(phone["height"], 844);
    let link = phone["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["text"]
                .as_str()
                .is_some_and(|s| s.starts_with("Explore the menu"))
        })
        .expect("visible menu link at phone width");
    let rect = image_rect(&apps[0]);
    let at = egui::pos2(
        rect.left()
            + rect.width()
                * (link["x"].as_f64().unwrap() + link["width"].as_f64().unwrap() / 2.0) as f32,
        rect.top()
            + rect.height()
                * (link["y"].as_f64().unwrap() + link["height"].as_f64().unwrap() / 2.0) as f32,
    );
    for pressed in [true, false] {
        apps[0].event(Event::PointerMoved(at));
        apps[0].event(Event::PointerButton {
            pos: at,
            button: PointerButton::Primary,
            pressed,
            modifiers: Modifiers::default(),
        });
        tick(&mut apps[0]);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !frame()["url"]
        .as_str()
        .is_some_and(|url| url.ends_with("#menu"))
        && std::time::Instant::now() < deadline
    {
        tick(&mut apps[0]);
    }
    if !frame()["url"]
        .as_str()
        .is_some_and(|url| url.ends_with("#menu"))
    {
        save(&mut apps[0], "click-failure.png");
        let evidence: Value = client
            .get(format!("{}/api/v1/demo/evidence", server.url))
            .bearer_auth(token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        std::fs::write(output.join("click-failure.json"), serde_json::to_vec_pretty(&json!({"evidence":evidence,"frame":phone,"element":link,"at":[at.x,at.y],"rect":[rect.left(),rect.top(),rect.right(),rect.bottom()]})).unwrap()).unwrap();
        std::fs::write(
            output.join("click-failure-ui.txt"),
            format!("{:#?}", apps[0].root()),
        )
        .unwrap();
        panic!("Menu click failed; inspect click-failure evidence");
    }
    until(&mut apps[1], "second client menu navigation", |a| {
        a.query_by_label("Address")
            .is_some_and(|n| n.value().is_some_and(|url| url.ends_with("#menu")))
    });
    save(&mut apps[1], "phone-menu.png");
    click(&mut apps[0], "Scroll down");
    until(&mut apps[0], "scroll complete", |a| {
        a.query_by_label("Annotate")
            .is_some_and(|n| !n.accesskit_node().is_disabled())
            && a.query_by_label("Desktop viewport")
                .is_some_and(|n| !n.accesskit_node().is_disabled())
    });
    click(&mut apps[0], "Annotate");
    until(&mut apps[0], "annotation ready", |a| {
        a.query_by_label("Cancel selection").is_some()
    });
    let rect = image_rect(&apps[0]);
    let at = rect.center();
    for pressed in [true, false] {
        apps[0].event(Event::PointerMoved(at));
        apps[0].event(Event::PointerButton {
            pos: at,
            button: PointerButton::Primary,
            pressed,
            modifiers: Modifiers::default(),
        });
        tick(&mut apps[0]);
    }
    until(&mut apps[0], "captured context", |a| {
        a.query_by_label("Remove attachment").is_some()
    });
    // Both clients keep rendering while the first person drafts feedback.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        for app in &mut apps {
            tick(app);
        }
    }
    click(&mut apps[1], "Desktop viewport");
    until(&mut apps[1], "desktop restored", |_| {
        frame()["width"] == 1280
    });
    fill(
        &mut apps[0],
        "Message",
        "Keep these sample prices easy to scan on a phone.",
    );
    click(&mut apps[0], "Send");
    let activity_path = format!(
        "{}/api/v1/rat/sessions/{}/activity",
        server.url,
        config["sessionId"].as_str().unwrap()
    );
    let activity = || -> Value {
        client
            .get(&activity_path)
            .bearer_auth(token)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    };
    until(&mut apps[0], "saved phone annotation", |_| {
        activity()["workspace_threads"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    });
    until(&mut apps[1], "second client feedback", |a| {
        a.query_all_by_label_contains("Keep these sample prices")
            .next()
            .is_some()
    });
    save(&mut apps[0], "feedback.png");
    apps[1]
        .query_all_by_label_contains("View annotation · Taco Cometa")
        .next()
        .expect("published source link")
        .click();
    until(&mut apps[1], "original phone capture", |a| {
        a.query_all_by_role(Role::Image)
            .map(|node| node.rect())
            .max_by(|a, b| a.area().total_cmp(&b.area()))
            .is_some_and(|r| (r.width() / r.height() - 390.0 / 844.0).abs() < 0.01)
    });
    save(&mut apps[1], "saved-phone-capture.png");
    assert_eq!(
        frame()["width"],
        1280,
        "viewing a phone capture does not resize the live browser"
    );
    let evidence = activity();
    std::fs::write(
        output.join("activity.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    std::fs::write(
        output.join("evidence.json"),
        serde_json::to_vec_pretty(&json!({
            "status": "passed",
            "clients": 2,
            "model": "deterministic local fixture",
            "paid_inference_calls": 0,
            "checks": [
                "Phone resize reaches both native clients",
                "Native click follows menu link after resize",
                "Second client sees the same navigation",
                "Scroll controls work outside the keyboard menu",
                "Phone annotation is published after another client restores Desktop",
                "Other client sees feedback",
                "Published phone capture reopens while the live browser stays Desktop"
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    drop(apps);
    server.stop();
    assert!(output.join("cleanup.json").exists());
}
