use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum ReadScope {
    List,
    Detail,
    Activity,
    Credentials,
}

impl ReadScope {
    pub fn pending(pending: &Pending) -> Option<Self> {
        match pending {
            Pending::List { .. } => Some(Self::List),
            Pending::Detail { .. } => Some(Self::Detail),
            Pending::Snapshot { .. } => Some(Self::Activity),
            Pending::Credentials { .. } => Some(Self::Credentials),
            _ => None,
        }
    }

    fn recovered(self, data: &Data) -> bool {
        matches!(
            (self, data),
            (Self::List, Data::Page(_))
                | (Self::Detail, Data::Resource(_))
                | (Self::Activity, Data::Snapshot(_) | Data::ActivityConnected)
                | (Self::Credentials, Data::Credentials(_))
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::List => "Couldn’t update the list",
            Self::Detail => "Couldn’t update details",
            Self::Activity => "Updates paused · Reconnecting…",
            Self::Credentials => "Couldn’t update credentials",
        }
    }
}

#[derive(Default)]
pub(super) struct ReadStatus {
    errors: HashMap<ReadScope, String>,
}

/// Only a response proving that this read recovered retires its failure.
/// Idle/cancelled streams and unrelated successful effects do not.
fn next_error(
    scope: ReadScope,
    current: Option<&str>,
    result: &Result<Data, String>,
) -> Option<String> {
    match result {
        Err(error) => Some(error.clone()),
        Ok(data) if scope.recovered(data) => None,
        _ => current.map(str::to_owned),
    }
}

impl ReadStatus {
    pub fn get(&self, scope: ReadScope) -> Option<&str> {
        self.errors.get(&scope).map(String::as_str)
    }

    pub fn settle(&mut self, scope: ReadScope, result: &Result<Data, String>) {
        if let Some(error) = next_error(scope, self.get(scope), result) {
            self.errors.insert(scope, error);
        } else {
            self.errors.remove(&scope);
        }
    }

    pub fn leave_selection(&mut self) {
        self.errors.retain(|scope, _| *scope == ReadScope::List);
    }
}

impl ConsoleApp {
    pub(super) fn read_status_line(&mut self, ui: &mut Ui, scope: ReadScope) {
        let Some(error) = self.read_status.get(scope).map(str::to_owned) else {
            return;
        };
        ui.horizontal_wrapped(|ui| {
            confirmation_label(ui, scope.label(), theme::ERROR).on_hover_text(error);
            if scope != ReadScope::Activity {
                let pending = self
                    .pending
                    .values()
                    .any(|request| ReadScope::pending(&request.operation) == Some(scope));
                if icons::button_enabled(ui, !pending, Icon::Refresh, "Retry update").clicked() {
                    match scope {
                        ReadScope::List => self.refresh_list(false, ui.ctx()),
                        ReadScope::Detail => self.refresh_selection(ui.ctx()),
                        ReadScope::Credentials => self.refresh_credentials(ui.ctx()),
                        ReadScope::Activity => {}
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_is_owned_by_the_matching_read() {
        let mut status = ReadStatus::default();
        status.settle(ReadScope::Activity, &Err("timed out".into()));
        status.settle(
            ReadScope::Credentials,
            &Err("credentials unavailable".into()),
        );
        status.settle(ReadScope::Activity, &Ok(Data::Mutation(Value::Null)));
        status.settle(ReadScope::Activity, &Ok(Data::ActivityIdle));
        assert_eq!(status.get(ReadScope::Activity), Some("timed out"));
        status.settle(ReadScope::Activity, &Ok(Data::ActivityConnected));
        assert_eq!(status.get(ReadScope::Activity), None);
        assert_eq!(
            status.get(ReadScope::Credentials),
            Some("credentials unavailable")
        );
        status.leave_selection();
        assert_eq!(status.get(ReadScope::Credentials), None);
    }

    #[test]
    fn receive_fences_old_read_results_and_preserves_mutation_errors() {
        use crate::api::Completion;
        let mut app = ConsoleApp::new("http://127.0.0.1:9".into(), "fixture".into()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        app.worker.activity_completions = rx;
        app.selection_generation = 2;
        app.error = Some("Send could not be confirmed".into());
        app.read_status
            .settle(ReadScope::Activity, &Err("Current read failed".into()));
        app.pending
            .insert(1, PendingRequest::new(Pending::Snapshot { generation: 1 }));
        tx.send(Completion {
            id: 1,
            finished: true,
            result: Ok(Data::ActivityConnected),
        })
        .unwrap();
        app.receive(&egui::Context::default());
        assert_eq!(
            app.read_status.get(ReadScope::Activity),
            Some("Current read failed")
        );
        app.pending
            .insert(2, PendingRequest::new(Pending::Snapshot { generation: 2 }));
        tx.send(Completion {
            id: 2,
            finished: false,
            result: Ok(Data::ActivityConnected),
        })
        .unwrap();
        app.receive(&egui::Context::default());
        assert_eq!(app.read_status.get(ReadScope::Activity), None);
        assert_eq!(app.error.as_deref(), Some("Send could not be confirmed"));
        app.pending
            .insert(3, PendingRequest::new(Pending::Snapshot { generation: 1 }));
        tx.send(Completion {
            id: 3,
            finished: true,
            result: Err("Old timeout".into()),
        })
        .unwrap();
        app.receive(&egui::Context::default());
        assert_eq!(app.read_status.get(ReadScope::Activity), None);
    }
}
