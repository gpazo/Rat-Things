//! Opt-in recording of three independent native clients against a real local worker.
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
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use support::{App, Server};

struct Recording {
    apps: Vec<App>,
    directory: PathBuf,
    frames: Vec<Value>,
    focus: usize,
    caption: String,
    started: Instant,
}
impl Recording {
    fn step(&mut self) {
        let before = Instant::now();
        for app in &mut self.apps {
            app.run_steps(2);
        }
        let index = self.frames.len();
        for (person, app) in self.apps.iter_mut().enumerate() {
            app.render()
                .expect("render actual native controls")
                .save(self.directory.join(format!("{index:05}-{person}.png")))
                .unwrap();
        }
        self.frames.push(json!({"frame":index,"focus":self.focus,"caption":self.caption,"elapsed_ms":self.started.elapsed().as_millis()}));
        std::fs::write(
            self.directory.join("frames.json"),
            serde_json::to_vec(&self.frames).unwrap(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(200).saturating_sub(before.elapsed()));
    }
    fn hold(&mut self, seconds: f32) {
        let until = Instant::now() + Duration::from_secs_f32(seconds);
        while Instant::now() < until {
            self.step();
        }
    }
    fn until(&mut self, label: &str, condition: impl Fn(&App) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !condition(&self.apps[self.focus]) {
            self.step();
            assert!(
                Instant::now() < deadline,
                "Waiting for {label}: {:#?}",
                self.apps[self.focus].root()
            );
        }
    }
    fn click(&mut self, label: &str) {
        self.until(label, |app| {
            app.query_by_label(label)
                .is_some_and(|node| !node.accesskit_node().is_disabled())
        });
        self.apps[self.focus].get_by_label(label).scroll_to_me();
        self.step();
        self.apps[self.focus].get_by_label(label).click();
        self.step();
    }
    fn type_text(&mut self, label: &str, text: &str) {
        self.until(label, |app| app.query_by_label(label).is_some());
        self.apps[self.focus].get_by_label(label).focus();
        self.step();
        for word in text.split_inclusive(' ') {
            self.apps[self.focus].get_by_label(label).type_text(word);
            self.step();
        }
    }
    fn image_rect(&self) -> egui::Rect {
        self.apps[self.focus]
            .query_all_by_role(Role::Image)
            .map(|node| node.rect())
            .max_by(|a, b| a.area().total_cmp(&b.area()))
            .expect("browser preview image")
    }
    fn point(&mut self, x: f32, y: f32, down: bool) {
        let rect = self.image_rect();
        let pos = rect.min + Vec2::new(rect.width() * x, rect.height() * y);
        self.apps[self.focus].event(Event::PointerMoved(pos));
        self.apps[self.focus].event(Event::PointerButton {
            pos,
            button: PointerButton::Primary,
            pressed: down,
            modifiers: Modifiers::default(),
        });
        self.step();
    }
    fn send(&mut self) {
        let label = if self.apps[self.focus]
            .query_by_role_and_label(Role::Button, "Send")
            .is_some()
        {
            "Send"
        } else {
            "Steer"
        };
        self.click(label);
    }
    fn scene(&mut self, focus: usize, caption: &str) {
        self.focus = focus;
        self.caption = caption.into();
        self.step();
    }
}

#[test]
#[ignore = "Starts Docker and records native clients; fixture inference only"]
fn record_multiplayer_shared_workspace() {
    assert_eq!(
        std::env::var("RAT_SHARED_WORKSPACE_DEMO").as_deref(),
        Ok("true")
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = root.join("test-results/shared-workspace-demo");
    std::fs::create_dir_all(&output).unwrap();
    let control = uuid::Uuid::new_v4().to_string();
    let mut server = Server::spawn(
        &root,
        "testing/shared-workspace/demo-server.ts",
        &[
            ("RAT_SHARED_WORKSPACE_DEMO", "true"),
            ("RAT_DEMO_CONTROL", &control),
        ],
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let config: Value = client
        .get(format!("{}/demo/config", server.url))
        .header("x-demo-control", &control)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    let people = config["people"].as_array().unwrap();
    let apps = people
        .iter()
        .map(|person| {
            Harness::builder()
                .with_size(Vec2::new(1280.0, 850.0))
                .build_eframe(|_| {
                    ConsoleApp::new(server.url.clone(), person["token"].as_str().unwrap().into())
                        .unwrap()
                })
        })
        .collect();
    let mut demo = Recording {
        apps,
        directory: output.clone(),
        frames: vec![],
        focus: 0,
        caption: "One session. Three collaborators. One shared agent.".into(),
        started: Instant::now(),
    };
    for person in 0..3 {
        demo.focus = person;
        demo.click("Works on our machines");
        demo.until("composer", |app| app.query_by_label("Message").is_some());
    }
    demo.scene(0, "Three teammates review one product direction.");
    demo.until("live browser", |app| {
        app.query_by_label("Annotate").is_some()
    });
    demo.hold(2.0);
    demo.scene(0, "Maya selects the headline and writes in chat.");
    demo.click("Annotate");
    demo.until("captured page", |app| {
        app.query_by_label("Click an element or drag a region.")
            .is_some()
    });
    demo.point(0.28, 0.24, true);
    demo.point(0.28, 0.24, false);
    demo.type_text("Message", "Lead with shared evidence, not blame.");
    demo.hold(1.0);
    for person in [1, 2] {
        assert!(
            demo.apps[person]
                .query_by_label("Maya · Designer is typing…")
                .is_some()
        );
    }
    demo.send();
    demo.hold(3.0);
    demo.scene(1, "Eli narrows the scope while everyone follows.");
    demo.type_text(
        "Message",
        "First release: runtime versions and the failing command. Automatic repair can wait.",
    );
    demo.send();
    demo.hold(3.0);
    demo.scene(
        2,
        "Sam marks a region and challenges the offline experience.",
    );
    demo.click("Annotate");
    demo.until("captured page", |app| {
        app.query_by_label("Click an element or drag a region.")
            .is_some()
    });
    demo.point(0.04, 0.39, true);
    let rect = demo.image_rect();
    demo.apps[2].event(Event::PointerMoved(
        rect.min + Vec2::new(rect.width() * 0.89, rect.height() * 0.59),
    ));
    demo.step();
    demo.point(0.89, 0.59, false);
    demo.type_text(
        "Message",
        "What happens offline? Keep the captured evidence readable.",
    );
    demo.send();
    demo.hold(3.0);
    demo.scene(
        2,
        "The agent owns the Plan. Everyone can follow the decisions.",
    );
    demo.click("Plan");
    demo.until("all feedback in Plan", |app| {
        app.query_by_label("Revision 4 · 2 of 3 addressed")
            .is_some()
    });
    demo.hold(2.0);
    demo.click("Decide what works offline");
    demo.hold(3.0);
    demo.scene(0, "Each decision links back to the person who raised it.");
    demo.click("Plan");
    demo.click("Lead with shared evidence");
    demo.hold(3.0);
    demo.scene(0, "Open the saved result from the Plan.");
    demo.click("Open direction.md");
    demo.until("saved result", |app| {
        app.query_all_by_label_contains("Compare environments together")
            .next()
            .is_some()
            || app
                .query_all_by_role(Role::TextRun)
                .filter_map(|node| node.value())
                .collect::<String>()
                .contains("Compare environments together")
    });
    demo.hold(4.0);
    let evidence: Value = client
        .get(format!("{}/api/v1/demo/evidence", server.url))
        .bearer_auth(people[0]["token"].as_str().unwrap())
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(evidence["image_delivered"], true);
    assert_eq!(evidence["stream_clients"].as_array().unwrap().len(), 3);
    assert_eq!(evidence["plan"]["revision"], 4);
    let items = evidence["plan"]["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .filter(|item| item["state"] == "addressed")
            .count(),
        2
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| item["state"] == "deferred")
            .count(),
        1
    );
    assert!(
        items
            .iter()
            .all(|item| !item["source_refs"].as_array().unwrap().is_empty())
    );
    assert!(
        evidence["turns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|turn| turn["status"] == "completed")
    );
    let proof = json!({"status":"passed","native_clients":3,"fixture_inference":true,"oidc":"Fixture identities, not a login-provider test","linux_worker":true,"captured_image_delivered_to_codex":true,"plan_revision":4,"fixture_requests":evidence["fixture_requests"],"frames":demo.frames.len(),"wall_duration_ms":demo.started.elapsed().as_millis(),"limitations":["Headless native component rendering, not OS window management","Scripted model replies and Plan decisions, seeded output document; no paid inference","Recording playback timing is edited for readability"]});
    let artifact = root.join("artifacts/shared-workspace/feedback-demo");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(
        artifact.join("evidence.json"),
        serde_json::to_vec_pretty(&proof).unwrap(),
    )
    .unwrap();
    std::fs::write(
        artifact.join("activity.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    drop(demo);
    server.stop();
    assert!(
        artifact.join("cleanup.json").is_file(),
        "Demo resource cleanup must complete"
    );
}
