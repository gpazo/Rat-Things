use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ContributionKind {
    Message,
    Feedback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum SaveOutcome {
    Saving,
    Saved,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ContributionReceipt {
    pub request: u64,
    pub kind: ContributionKind,
    pub outcome: SaveOutcome,
}

impl ContributionReceipt {
    /// A late response cannot confirm a newer submission.
    fn completed(&self, request: u64, result: &Result<Data, String>) -> Self {
        if request != self.request || self.outcome != SaveOutcome::Saving {
            return self.clone();
        }
        let outcome = match result {
            Ok(Data::Mutation(_)) => SaveOutcome::Saved,
            Err(error) => SaveOutcome::Failed(error.clone()),
            _ => SaveOutcome::Failed("The save response was unexpected.".into()),
        };
        Self {
            outcome,
            ..self.clone()
        }
    }

    fn label(&self) -> &'static str {
        match (&self.outcome, self.kind) {
            (SaveOutcome::Saving, ContributionKind::Message) => "Sending message…",
            (SaveOutcome::Saving, ContributionKind::Feedback) => "Sending feedback…",
            (SaveOutcome::Saved, ContributionKind::Message) => "Last message sent",
            (SaveOutcome::Saved, ContributionKind::Feedback) => "Last feedback sent",
            (SaveOutcome::Failed(_), _) => "Last send not confirmed",
        }
    }
}

impl CollaborationUi {
    pub(super) fn settle_contribution(
        &mut self,
        session: &str,
        request: u64,
        result: &Result<Data, String>,
    ) {
        if let Some(receipt) = self.submissions.get_mut(session) {
            *receipt = receipt.completed(request, result);
        }
    }

    pub(super) fn editing_contribution(&mut self, session: &str) {
        if self
            .submissions
            .get(session)
            .is_some_and(|receipt| receipt.outcome != SaveOutcome::Saving)
        {
            self.submissions.remove(session);
        }
    }
}

impl ConsoleApp {
    fn contribution_receipt(&self, session: &str) -> Option<&ContributionReceipt> {
        self.collaboration
            .submissions
            .get(session)
            .filter(|receipt| {
                receipt.outcome != SaveOutcome::Saving
                    || self.pending.get(&receipt.request).is_some_and(|pending| {
                        match &pending.operation {
                            Pending::Artifact {
                                session_generation,
                                generation,
                                ..
                            } => {
                                *session_generation == self.selection_generation
                                    && *generation == self.artifact_workspace.generation
                            }
                            Pending::Mutation(Effect::Event { .. }) => true,
                            _ => false,
                        }
                    })
            })
    }
    /// Used by the native driver to wait for the same durable acknowledgment users see.
    pub fn message_submission_pending(&self) -> bool {
        self.selected_id
            .as_ref()
            .and_then(|id| self.contribution_receipt(id))
            .is_some_and(|receipt| receipt.outcome == SaveOutcome::Saving)
    }

    pub fn message_submission_result(&self) -> Option<(u64, Option<String>)> {
        let receipt = self.contribution_receipt(self.selected_id.as_ref()?)?;
        match &receipt.outcome {
            SaveOutcome::Saving => None,
            SaveOutcome::Saved => Some((receipt.request, None)),
            SaveOutcome::Failed(error) => Some((receipt.request, Some(error.clone()))),
        }
    }

    pub(super) fn contribution_status(&self, ui: &mut Ui, session: &str, draft: &str) {
        let receipt = self.contribution_receipt(session).filter(|receipt| {
            receipt.outcome != SaveOutcome::Saved
                || (draft.is_empty()
                    && !self.collaboration.contexts.contains_key(session)
                    && !self.collaboration.replies.contains_key(session))
        });
        if let Some(receipt) = receipt {
            let color = match receipt.outcome {
                SaveOutcome::Failed(_) => theme::ERROR,
                SaveOutcome::Saving => theme::MUTED,
                SaveOutcome::Saved => theme::TEXT,
            };
            let response = confirmation_label(ui, receipt.label(), color);
            response.on_hover_text(match &receipt.outcome {
                SaveOutcome::Saved => "Your last contribution is saved in this chat. Follow the agent’s progress above.",
                SaveOutcome::Saving => "Waiting for the service to confirm your contribution.",
                SaveOutcome::Failed(error) => error,
            });
        } else {
            ui.label(
                RichText::new("⌘ / Ctrl + Enter")
                    .small()
                    .color(theme::MUTED),
            );
        }
    }
}

pub(super) fn confirmation_label(ui: &mut Ui, text: &str, color: Color32) -> egui::Response {
    let response = ui.label(RichText::new(text).small().color(color));
    ui.ctx().accesskit_node_builder(response.id, |node| {
        node.set_role(egui::accesskit::Role::Status);
        node.set_label(text);
        node.set_live(egui::accesskit::Live::Polite);
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_outcome_requires_its_own_mutation_acknowledgment() {
        let pending = ContributionReceipt {
            request: 7,
            kind: ContributionKind::Message,
            outcome: SaveOutcome::Saving,
        };
        assert_eq!(
            pending.completed(6, &Ok(Data::Mutation(Value::Null))),
            pending
        );
        let saved = pending.completed(7, &Ok(Data::Mutation(Value::Null)));
        assert_eq!(saved.outcome, SaveOutcome::Saved);
        assert_eq!(saved.completed(7, &Err("late duplicate".into())), saved);
        assert_eq!(
            pending.completed(7, &Err("offline".into())).outcome,
            SaveOutcome::Failed("offline".into())
        );
    }

    #[test]
    fn editing_clears_a_receipt_but_preserves_an_inflight_save() {
        let mut collaboration = CollaborationUi::default();
        collaboration.submissions.insert(
            "s".into(),
            ContributionReceipt {
                request: 7,
                kind: ContributionKind::Feedback,
                outcome: SaveOutcome::Saving,
            },
        );
        collaboration.editing_contribution("s");
        assert!(collaboration.submissions.contains_key("s"));
        collaboration.settle_contribution("s", 7, &Ok(Data::Mutation(Value::Null)));
        collaboration.editing_contribution("s");
        assert!(!collaboration.submissions.contains_key("s"));
    }
}
