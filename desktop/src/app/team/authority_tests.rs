use super::*;
use egui_kittest::{Harness, kittest::Queryable};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

fn harness(app: ConsoleApp) -> Harness<'static, ConsoleApp> {
    let mut harness = Harness::new_ui_state(
        |ui, app: &mut ConsoleApp| {
            theme::apply(ui.ctx());
            app.show(ui);
        },
        app,
    );
    harness.set_size(egui::vec2(1280.0, 850.0));
    harness.run_steps(2);
    harness
}

fn held_authority(
    status: u16,
    body: Value,
) -> (
    String,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (arrived, received) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut headers = Vec::new();
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&headers).starts_with("GET /api/v1/rat/spaces "));
        arrived.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        let body = body.to_string();
        write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    (endpoint, received, release, server)
}
fn authority_app(endpoint: String, collection: Collection, workspace_open: bool) -> ConsoleApp {
    let mut app = ConsoleApp::new(endpoint, "fixture".into()).unwrap();
    app.initialized = true;
    app.team.loaded = true;
    app.team.saved_shares_loaded = true;
    app.messages
        .insert("sess_shared".into(), "Keep my draft".into());
    app.workspace = Some(
        json!({"kind":"team","space_id":"space","name":"Team space","role":"manager","permissions":["read","configure","credentials","manage_space"]}),
    );
    app.collection = collection;
    app.workspace_open = workspace_open;
    app.snapshot = None;
    let resource: Resource =
        serde_json::from_value(json!({"id":"cached","name":"Cached protected resource"})).unwrap();
    app.resources = vec![resource.clone()];
    app.selected_id = (collection != Collection::Sessions).then(|| resource.id.clone());
    app.selected = (collection != Collection::Sessions).then_some(resource);
    app.detail_loaded = true;
    app.credentials_loaded = true;
    app.credentials = vec![
        serde_json::from_value(json!({"id":"credential","name":"Cached credential"})).unwrap(),
    ];
    app.team.bindings = Some(vec![json!({"subject":"Cached member","role":"manager"})]);
    app.team.authority_due = Some(Instant::now());
    app.team.authority_valid_until = Some(Instant::now() + AUTHORITY_MAX_AGE);
    app.next_refresh = Instant::now() + Duration::from_secs(60);
    app
}
fn receive_authority(ui: &mut Harness<'_, ConsoleApp>) {
    for _ in 0..100 {
        ui.step();
        if ui.state().team.authority_pending.is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("Authority response was not applied");
}

type HeldResponse = (String, mpsc::Sender<Value>);

fn held_responses(
    count: usize,
) -> (
    String,
    mpsc::Receiver<HeldResponse>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (arrived, received) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut replies = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let request = String::from_utf8(headers)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_owned();
            let (release, wait) = mpsc::channel::<Value>();
            arrived.send((request, release)).unwrap();
            replies.push(std::thread::spawn(move || {
                let body = wait.recv_timeout(Duration::from_secs(5)).unwrap().to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }));
        }
        for reply in replies {
            reply.join().unwrap();
        }
    });
    (endpoint, received, server)
}
#[test]
fn idle_authority_revocation_clears_every_view_with_workspace_open_or_closed() {
    for collection in [
        Collection::Sessions,
        Collection::Agents,
        Collection::Templates,
        Collection::Vaults,
    ] {
        for workspace_open in [false, true] {
            let (endpoint, received, release, server) =
                held_authority(403, json!({"error":{"message":"Revoked"}}));
            let mut state = authority_app(endpoint, collection, workspace_open);
            state.team.pending = Some(999);
            state.pending.insert(
                999,
                PendingRequest::new(Pending::Team(TeamOperation::LoginStatus)),
            );
            let mut ui = harness(state);
            received.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(ui.state().resources.len(), 1);
            assert_eq!(ui.state().role(), Role::Manager);
            std::thread::sleep(LOADING_FEEDBACK_DELAY + Duration::from_millis(10));
            ui.step();
            assert_eq!(ui.state().resources.len(), 1);
            release.send(()).unwrap();
            server.join().unwrap();
            receive_authority(&mut ui);
            assert_eq!(
                ui.state().role(),
                Role::NoAccess,
                "{collection:?}, workspace {workspace_open}"
            );
            assert!(ui.state().resources.is_empty());
            assert!(ui.state().selected.is_none());
            assert!(ui.state().credentials.is_empty());
            assert!(ui.state().team.bindings.is_none());
            assert!(ui.state().messages.is_empty());
            assert!(ui.state().snapshot.is_none());
            assert_eq!(ui.state().team.pending, Some(999));
        }
    }
}
#[test]
fn idle_downgrade_removes_vault_content_and_reloads_allowed_sessions() {
    let (endpoint, received, server) = held_responses(2);
    let mut state = authority_app(endpoint, Collection::Vaults, true);
    state.pending.insert(
        998,
        PendingRequest::new(Pending::Credentials {
            generation: state.selection_generation,
        }),
    );
    state.pending.insert(
        999,
        PendingRequest::new(Pending::Team(TeamOperation::Bindings)),
    );
    state.team.pending = Some(999);
    let mut ui = harness(state);
    let (request, release) = received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(request.starts_with("GET /api/v1/rat/spaces "));
    release
        .send(json!({"data":[{"id":"space","role":"viewer","permissions":["read"]}]}))
        .unwrap();
    receive_authority(&mut ui);
    assert_eq!(ui.state().role(), Role::Viewer);
    assert!(!ui.state().can_manage());
    assert_eq!(ui.state().collection, Collection::Sessions);
    assert!(ui.state().resources.is_empty());
    assert!(ui.state().selected.is_none());
    assert!(ui.state().credentials.is_empty());
    assert!(ui.state().team.bindings.is_none());
    assert!(!ui.state().pending.contains_key(&998));
    assert!(!ui.state().pending.contains_key(&999));
    assert!(ui.query_by_label("Grant space role").is_none());
    let (request, release) = received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(request.starts_with("GET /api/v1/agents/sessions?"));
    release
        .send(json!({"data":[{"id":"sess_readable","name":"Readable Session"}],"has_more":false}))
        .unwrap();
    server.join().unwrap();
    for _ in 0..100 {
        ui.step();
        if ui.state().list_pending.is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(ui.state().resources.len(), 1);
    assert_eq!(ui.state().resources[0].id, "sess_readable");
    assert!(ui.state().credentials.is_empty());
    assert!(ui.state().team.bindings.is_none());
}

#[test]
fn idle_role_change_restarts_held_readable_details_and_discards_the_old_reply() {
    for collection in [Collection::Agents, Collection::Templates] {
        let (endpoint, received, server) = held_responses(3);
        let mut state = authority_app(endpoint, collection, false);
        state.detail_loaded = false;
        state.refresh_selection(&egui::Context::default());
        let (request, old_reply) = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with(&format!("GET {} ", collection.resource_path("cached"))));
        let mut ui = harness(state);
        let (request, release) = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with("GET /api/v1/rat/spaces "));
        release
            .send(json!({"data":[{"id":"space","role":"viewer","permissions":["read"]}]}))
            .unwrap();
        receive_authority(&mut ui);
        assert_eq!(ui.state().role(), Role::Viewer);
        assert!(ui.state().detail_pending.is_some());
        let (request, release) = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with(&format!("GET {} ", collection.resource_path("cached"))));
        release
            .send(json!({"id":"cached","name":"Current readable details"}))
            .unwrap();
        for _ in 0..100 {
            ui.step();
            if ui.state().detail_loaded {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(ui.state().detail_loaded);
        old_reply
            .send(json!({"id":"cached","name":"Stale details"}))
            .unwrap();
        server.join().unwrap();
        for _ in 0..100 {
            ui.step();
            if !ui
                .state()
                .pending
                .values()
                .any(|request| matches!(request.operation, Pending::Detail { .. }))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            ui.state().selected.as_ref().unwrap().fields["name"].as_str(),
            Some("Current readable details")
        );
        assert_eq!(ui.state().role(), Role::Viewer);
        assert_eq!(ui.state().collection, collection);
    }
}
#[test]
fn idle_expired_identity_and_missing_membership_both_clear_the_unselected_session_index() {
    for (status, body) in [
        (401, json!({"error":{"message":"Sign-in expired"}})),
        (200, json!({"data":[]})),
    ] {
        let (endpoint, received, release, server) = held_authority(status, body);
        let mut ui = harness(authority_app(endpoint, Collection::Sessions, false));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        receive_authority(&mut ui);
        assert_eq!(ui.state().role(), Role::NoAccess);
        assert!(ui.state().resources.is_empty());
    }
}
#[test]
fn delayed_authority_cannot_restore_an_earlier_role_or_clear_another_workspace() {
    for switch_workspace in [false, true] {
        let (endpoint, received, release, server) = held_authority(
            200,
            json!({"data":[{"id":"space","role":"manager","permissions":["read","configure","credentials","manage_space"]}]}),
        );
        let mut ui = harness(authority_app(endpoint, Collection::Agents, false));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        if switch_workspace {
            ui.state_mut().local_generation += 1;
            ui.state_mut().workspace = Some(json!({"kind":"local"}));
        } else {
            ui.state_mut().update_team_authority(
                "viewer",
                Some(&["read".into()]),
                &egui::Context::default(),
            );
        }
        release.send(()).unwrap();
        server.join().unwrap();
        receive_authority(&mut ui);
        assert_eq!(ui.state().resources.len(), 1);
        if switch_workspace {
            assert!(ui.state().is_local());
        } else {
            assert_eq!(ui.state().role(), Role::Viewer);
        }
    }
}
#[test]
fn stale_authority_expires_while_its_request_is_still_pending() {
    let (endpoint, received, release, server) = held_authority(
        200,
        json!({"data":[{"id":"space","role":"manager","permissions":["read","configure"]}]}),
    );
    let mut ui = harness(authority_app(endpoint, Collection::Agents, true));
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    ui.state_mut().team.authority_valid_until = Some(Instant::now() - Duration::from_millis(1));
    ui.step();
    assert_eq!(ui.state().role(), Role::NoAccess);
    assert!(ui.state().resources.is_empty());
    release.send(()).unwrap();
    server.join().unwrap();
    receive_authority(&mut ui);
    assert_eq!(ui.state().role(), Role::NoAccess);
}
