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
    fn click_point(&mut self, x: f32, y: f32) {
        self.until("browser ready for interaction", |app| {
            app.query_by_role_and_label(Role::Button, "Go")
                .is_some_and(|node| !node.accesskit_node().is_disabled())
        });
        let rect = self.image_rect();
        let pos = rect.min + Vec2::new(rect.width() * x, rect.height() * y);
        self.apps[self.focus].event(Event::PointerMoved(pos));
        for pressed in [true, false] {
            self.apps[self.focus].event(Event::PointerButton {
                pos,
                button: PointerButton::Primary,
                pressed,
                modifiers: Modifiers::default(),
            });
        }
        self.step();
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
    demo.scene(
        0,
        "Maya, designer: challenge the framing while everyone follows.",
    );
    demo.hold(2.0);
    demo.type_text("Message", "Show the environment difference, not blame.");
    demo.hold(1.5);
    assert!(
        demo.apps[0]
            .query_by_label("Maya · Designer is typing…")
            .is_none()
    );
    for person in [1, 2] {
        assert!(
            demo.apps[person]
                .query_by_label("Maya · Designer is typing…")
                .is_some()
        );
    }
    demo.click("Send");
    demo.hold(3.0);
    for person in 0..3 {
        demo.focus = person;
        demo.click("Shared workspace");
        demo.click("Live browser");
        demo.until("live page", |app| {
            app.query_by_label("https://rat-artifacts.invalid/index.html")
                .is_some()
        });
    }
    demo.scene(
        1,
        "Eli clicks the live page. Everyone sees the same browser.",
    );
    demo.hold(2.0);
    // The page's only button is in the lower left of the actual browser frame.
    eprintln!("Browser preview bounds: {:?}", demo.image_rect());
    demo.click_point(0.17, 0.66);
    demo.hold(2.0);
    let browser: Value = client
        .get(format!(
            "{}/api/v1/rat/sessions/{}/workspace/browser",
            server.url,
            config["sessionId"].as_str().unwrap()
        ))
        .bearer_auth(people[0]["token"].as_str().unwrap())
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    {
        use base64::Engine;
        std::fs::write(
            output.join("browser-frame.jpg"),
            base64::engine::general_purpose::STANDARD
                .decode(browser["image"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
    }
    let diagnostic: Value = client
        .get(format!("{}/api/v1/demo/evidence", server.url))
        .bearer_auth(people[0]["token"].as_str().unwrap())
        .send()
        .unwrap()
        .json()
        .unwrap();
    eprintln!("Browser commands: {}", diagnostic["browser_commands"]);
    assert!(
        browser["text"]
            .as_str()
            .unwrap()
            .contains("Works on our machines."),
        "Shared click did not update the page: {}",
        browser["text"]
    );
    demo.scene(0, "Maya pins design feedback to an exact captured page.");
    demo.click("Add comment");
    demo.hold(0.6);
    demo.point(0.28, 0.24, true);
    demo.point(0.28, 0.24, false);
    demo.type_text("Artifact feedback", "Lead with shared evidence, not blame.");
    demo.click("Share feedback");
    demo.hold(2.0);
    demo.scene(1, "Eli replies to Maya's annotation with a concrete scope.");
    demo.click("Feedback");
    demo.click("1 · Open");
    demo.type_text(
        "Artifact feedback",
        "First release: capture runtime versions and the failing command.",
    );
    demo.click("Share feedback");
    demo.hold(2.0);
    demo.scene(2, "Sam, QA: select a region and challenge the edge cases.");
    demo.click("Add comment");
    demo.hold(0.6);
    demo.point(0.04, 0.39, true);
    let rect = demo.image_rect();
    demo.apps[2].event(Event::PointerMoved(
        rect.min + Vec2::new(rect.width() * 0.89, rect.height() * 0.59),
    ));
    demo.step();
    demo.point(0.89, 0.59, false);
    demo.type_text("Artifact feedback","What happens offline? Keep captured evidence readable and reconnect without duplicate feedback.");
    demo.click("Share feedback");
    demo.hold(3.0);
    demo.scene(
        0,
        "The same discussion reaches all three clients, with authorship intact.",
    );
    for person in 0..3 {
        demo.focus = person;
        demo.click("1 · Open");
    }
    demo.focus = 0;
    demo.hold(3.0);
    demo.scene(
        1,
        "Resolve a discussion together; its original context stays saved.",
    );
    // There are two feedback threads; resolve the selected first one.
    demo.apps[1]
        .query_all_by_role_and_label(Role::Button, "Resolve")
        .next()
        .unwrap()
        .click();
    demo.step();
    demo.hold(1.0);
    demo.click("Show resolved");
    demo.click("Reopen");
    demo.hold(2.0);
    demo.scene(
        2,
        "One agent receives everyone's feedback and the captured image.",
    );
    for person in 0..3 {
        demo.focus = person;
        demo.click("← Conversation");
    }
    demo.focus = 2;
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
    let threads = evidence["workspace_threads"].as_array().unwrap();
    assert_eq!(threads.len(), 2);
    assert!(threads.iter().all(|thread| thread["resolved"] == false));
    let comments: Vec<_> = threads
        .iter()
        .flat_map(|thread| thread["comments"].as_array().unwrap())
        .collect();
    assert_eq!(comments.len(), 5);
    let actors: std::collections::HashSet<_> = comments
        .iter()
        .map(|comment| comment["actor"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(actors.len(), 3);
    assert_eq!(evidence["image_delivered"], true);
    assert_eq!(evidence["stream_clients"].as_array().unwrap().len(), 3);
    assert!(
        evidence["browser_text"]
            .as_str()
            .unwrap()
            .contains("Works on our machines.")
    );
    let anchors: std::collections::HashSet<_> = threads
        .iter()
        .map(|thread| thread["target"]["anchor"]["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        anchors,
        std::collections::HashSet::from(["point", "region"])
    );
    assert!(
        evidence["turns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|turn| turn["status"] == "completed")
    );
    let proof = json!({"status":"passed","native_clients":3,"fixture_inference":true,"oidc":"Fixture identities, not a login-provider test","linux_worker":true,"captured_image_delivered_to_codex":true,"annotation_threads":2,"comments":5,"actors":actors,"fixture_requests":evidence["fixture_requests"],"frames":demo.frames.len(),"wall_duration_ms":demo.started.elapsed().as_millis(),"limitations":["Headless native component rendering, not OS window management","Scripted model responses; no paid inference","Recording playback timing is edited for readability"]});
    let artifact = root.join("artifacts/shared-workspace/demo");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(
        artifact.join("evidence.json"),
        serde_json::to_vec_pretty(&proof).unwrap(),
    )
    .unwrap();
    drop(demo);
    server.stop();
    assert!(
        artifact.join("cleanup.json").is_file(),
        "Demo resource cleanup must complete"
    );
}
