use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collection {
    Sessions,
    Agents,
    Templates,
    Vaults,
}

impl Collection {
    pub const ALL: [Self; 4] = [Self::Sessions, Self::Agents, Self::Templates, Self::Vaults];

    pub fn title(self) -> &'static str {
        match self {
            Self::Sessions => "Sessions",
            Self::Agents => "Agents",
            Self::Templates => "Templates",
            Self::Vaults => "Vaults",
        }
    }

    pub fn singular(self) -> &'static str {
        match self {
            Self::Sessions => "session",
            Self::Agents => "agent",
            Self::Templates => "environment template",
            Self::Vaults => "vault",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Sessions => "/api/v1/agents/sessions",
            Self::Agents => "/api/v1/agents",
            Self::Templates => "/api/v1/agents/environments/templates",
            Self::Vaults => "/api/v1/vaults",
        }
    }

    pub fn resource_path(self, id: &str) -> String {
        format!("{}/{}", self.path(), path_segment(id))
    }

    pub fn initial(self, agent_id: Option<&str>) -> Value {
        match self {
            Self::Sessions => {
                let mut value = json!({"environment": {"type": "none"}, "input": "Describe the work to perform"});
                if let Some(id) = agent_id {
                    value["agent_id"] = id.into();
                } else {
                    value["agent"] = json!({"model": "your-model-id"});
                }
                value
            }
            Self::Agents => {
                json!({"name": "New agent", "model": "your-model-id", "instructions": "Describe the role and working instructions.", "tools": []})
            }
            Self::Templates => {
                json!({"name": "New environment", "files": [], "packages": {"npm": [], "python": [], "system": []}, "network": {"access": "disabled"}})
            }
            Self::Vaults => json!({"name": "New vault"}),
        }
    }
}

pub(crate) fn path_segment(value: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/").expect("static URL");
    url.path_segments_mut()
        .expect("hierarchical URL")
        .push(value);
    url.path().trim_start_matches('/').to_owned()
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Resource {
    pub id: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanUpdateStatus {
    Updating,
    Updated,
    Failed,
}

pub(crate) struct ConversationItem<'a> {
    pub item: &'a Resource,
    pub plan_update: Option<PlanUpdateStatus>,
}

pub(crate) fn conversation_items(items: &[Resource]) -> Vec<ConversationItem<'_>> {
    fn key(item: &Resource) -> (&str, &str) {
        (item.text("turn_id"), item.text("call_id"))
    }
    let plan_calls: HashSet<_> = items
        .iter()
        .filter(|item| {
            item.text("type") == "function_call" && item.text("name") == "rat_things_plan_update"
        })
        .map(key)
        .collect();
    let outputs: HashSet<_> = items
        .iter()
        .filter(|item| item.text("type") == "function_call_output")
        .map(key)
        .collect();
    items
        .iter()
        .filter_map(|item| {
            let call = key(item);
            let is_call = item.text("type") == "function_call" && plan_calls.contains(&call);
            let is_output = item.text("type") == "function_call_output"
                && (plan_calls.contains(&call) || item.text("name") == "rat_things_plan_update");
            if is_call && outputs.contains(&call) {
                return None;
            }
            let plan_update = (is_call || is_output).then(|| {
                if matches!(item.text("status"), "failed" | "cancelled")
                    || item
                        .fields
                        .get("error")
                        .is_some_and(|error| !error.is_null())
                    || item.fields.get("success").and_then(Value::as_bool) == Some(false)
                {
                    PlanUpdateStatus::Failed
                } else if is_output && item.text("status") == "completed" {
                    PlanUpdateStatus::Updated
                } else {
                    PlanUpdateStatus::Updating
                }
            });
            Some(ConversationItem { item, plan_update })
        })
        .collect()
}

fn saved_plan_revision(item: &Resource) -> Option<u64> {
    fn from_text(text: &str) -> Option<u64> {
        let output: Value = serde_json::from_str(text).ok()?;
        output["plan"]["revision"]
            .as_u64()
            .filter(|revision| *revision > 0)
    }
    if item.text("type") != "function_call_output" {
        return None;
    }
    let output = item.fields.get("output")?;
    output.as_str().and_then(from_text).or_else(|| {
        output.as_array()?.iter().find_map(|part| {
            matches!(part["type"].as_str(), Some("input_text" | "output_text"))
                .then(|| part["text"].as_str().and_then(from_text))
                .flatten()
        })
    })
}

pub(crate) const SESSION_ARCHIVED_KEY: &str = "rat_things_archived";

impl Resource {
    pub fn is_pinned_session(&self) -> bool {
        self.text("object") == "agent.session"
            && self
                .fields
                .get("metadata")
                .and_then(|metadata| metadata.get("rat_things_pinned"))
                .and_then(Value::as_str)
                == Some("true")
    }

    pub fn is_archived_session(&self) -> bool {
        self.text("object") == "agent.session"
            && self
                .fields
                .get("metadata")
                .and_then(|metadata| metadata.get(SESSION_ARCHIVED_KEY))
                .and_then(Value::as_str)
                == Some("true")
    }

    pub fn text(&self, key: &str) -> &str {
        self.fields
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn title(&self) -> &str {
        self.name().unwrap_or_else(|| {
            if self.text("object") == "agent.session" {
                "Untitled session"
            } else {
                &self.id
            }
        })
    }

    pub fn is_unnamed_session(&self) -> bool {
        self.text("object") == "agent.session" && self.name().is_none()
    }

    fn name(&self) -> Option<&str> {
        [
            self.fields.get("name").and_then(Value::as_str),
            self.fields
                .get("metadata")
                .and_then(|metadata| metadata.get("name"))
                .and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .find(|name| !name.trim().is_empty())
    }

    pub fn model(&self) -> &str {
        self.fields
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| self.fields.get("agent")?.get("model")?.as_str())
            .unwrap_or_default()
    }

    pub fn value(&self) -> Value {
        let mut fields = self.fields.clone();
        fields.insert("id".into(), self.id.clone().into());
        Value::Object(fields)
    }

    pub fn edit_body(&self, collection: Collection) -> Value {
        let fields: &[&str] = match collection {
            Collection::Agents => &[
                "name",
                "model",
                "instructions",
                "tools",
                "reasoning",
                "multi_agent",
                "text",
                "service_tier",
                "metadata",
            ],
            Collection::Templates => &["name", "capability_directories", "network", "packages"],
            Collection::Vaults => &["name"],
            Collection::Sessions => &["metadata"],
        };
        let mut body = Value::Object(
            fields
                .iter()
                .filter_map(|key| {
                    self.fields
                        .get(*key)
                        .map(|value| ((*key).into(), value.clone()))
                })
                .collect(),
        );
        if collection == Collection::Agents
            && let Some(multi_agent) = body.get_mut("multi_agent").and_then(Value::as_object_mut)
            && multi_agent
                .get("max_concurrent_subagents")
                .is_some_and(Value::is_null)
        {
            multi_agent.remove("max_concurrent_subagents");
        }
        body
    }
}

pub(crate) fn prompt_title(text: &str) -> Option<String> {
    let title: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    (!title.is_empty()).then_some(title)
}

/// A new conversation without an explicit name uses its first user prompt.
pub(crate) fn name_session_request(value: &mut Value) {
    if value
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.trim().is_empty())
    {
        return;
    }
    let input = value.get("input");
    let prompt = input.and_then(Value::as_str).or_else(|| {
        input?
            .as_array()?
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .find_map(|message| {
                message
                    .get("content")?
                    .as_array()?
                    .iter()
                    .find_map(|part| part.get("text")?.as_str())
            })
    });
    let Some(title) = prompt.and_then(prompt_title) else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let metadata = object.entry("metadata").or_insert_with(|| json!({}));
    if let Some(metadata) = metadata.as_object_mut() {
        metadata.insert("name".into(), title.into());
    }
}

#[derive(Clone, Deserialize)]
pub(crate) struct AvailableModel {
    pub id: String,
    #[serde(default)]
    pub reasoning: Vec<String>,
}

impl AvailableModel {
    pub fn label(&self) -> &str {
        &self.id
    }
}

#[derive(Clone, Deserialize)]
pub(crate) struct ModelCatalog {
    pub data: Vec<AvailableModel>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Value>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct RuntimeInfo {
    pub runtime: String,
}

#[derive(Deserialize)]
pub(crate) struct Page {
    pub data: Vec<Resource>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Clone)]
pub(crate) struct SessionSnapshot {
    pub workspace_threads: Vec<Value>,
    pub browser_available: bool,
    pub plan: Option<SessionPlan>,
    pub cursor: Option<String>,
    pub role: Option<String>,
    pub permissions: Option<Vec<String>>,
    pub actor_colors: std::collections::HashMap<String, String>,
    pub replies: std::collections::HashMap<String, Value>,
    pub actor_labels: std::collections::HashMap<String, String>,
    pub workspace_sources: HashMap<String, Value>,
    pub runtime: Result<RuntimeInfo, String>,
    pub session: Resource,
    pub items: Vec<Resource>,
    pub turns: Vec<Resource>,
    pub artifacts: Vec<Resource>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct SessionPlan {
    pub revision: u64,
    #[serde(default)]
    pub items: Vec<SessionPlanItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct SessionPlanItem {
    pub id: String,
    pub text: String,
    pub state: SessionPlanState,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<PlanSourceRef>,
    #[serde(default)]
    pub result_links: Vec<PlanResultLink>,
    pub updated_by: PlanUpdatedBy,
    pub updated_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionPlanState {
    Next,
    Working,
    Addressed,
    Deferred,
    Reopened,
    NeedsDiscussion,
}

impl SessionPlanState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Next => "Next",
            Self::Working => "Working",
            Self::Addressed => "Addressed",
            Self::Deferred => "Deferred",
            Self::Reopened => "Reopened",
            Self::NeedsDiscussion => "Needs discussion",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct PlanSourceRef {
    pub receipt_id: String,
    pub message_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PlanResultLink {
    Artifact {
        artifact_id: String,
        version_sha256: String,
    },
    Activity {
        turn_id: String,
        item_id: String,
    },
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub(crate) struct PlanUpdatedBy {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
}

impl SessionSnapshot {
    pub fn has_shared_workspace(&self) -> bool {
        self.browser_available
            || !self.artifacts.is_empty()
            || self
                .plan
                .as_ref()
                .is_some_and(|plan| plan.revision > 0 || !plan.items.is_empty())
    }

    pub fn from_activity(value: Value) -> Result<Self, String> {
        let parse = |name: &str| {
            serde_json::from_value(value[name].clone())
                .map_err(|_| format!("Invalid activity {name}"))
        };
        let mut actor_colors = std::collections::HashMap::new();
        let mut replies = std::collections::HashMap::new();
        let mut actor_labels = std::collections::HashMap::new();
        let mut workspace_sources = HashMap::new();
        for input in value["inputs"].as_array().into_iter().flatten() {
            let actor = &input["actor"];
            let label = actor["label"]
                .as_str()
                .or(actor["subject"].as_str())
                .or(actor["id"].as_str())
                .unwrap_or("Participant");
            let label = if input["provenance"]["kind"] == "imported" {
                format!("{label} (imported)")
            } else {
                label.to_owned()
            };
            for id in input["message_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                actor_labels.insert(id.to_owned(), label.clone());
                if let Some(color) = input["participant"]["color"].as_str() {
                    actor_colors.insert(id.to_owned(), color.to_owned());
                }
                if input["reply"].is_object() {
                    replies.insert(id.to_owned(), input["reply"].clone());
                }
                if input["workspace"].is_object() {
                    workspace_sources.insert(id.to_owned(), input["workspace"].clone());
                }
            }
        }
        let mut items: Vec<Resource> = parse("items")?;
        let saved_revisions: HashMap<_, _> = conversation_items(&items)
            .into_iter()
            .filter(|row| row.plan_update == Some(PlanUpdateStatus::Updated))
            .filter_map(|row| {
                saved_plan_revision(row.item).map(|revision| (row.item.id.clone(), revision))
            })
            .collect();
        for item in &mut items {
            item.fields.remove("saved_plan_revision");
            if let Some(revision) = saved_revisions.get(&item.id) {
                item.fields
                    .insert("saved_plan_revision".into(), (*revision).into());
            }
        }
        for receipt in value["pending_inputs"].as_array().into_iter().flatten() {
            let actor = &receipt["actor"];
            let label = actor["label"]
                .as_str()
                .or(actor["subject"].as_str())
                .or(actor["id"].as_str())
                .unwrap_or("Participant")
                .to_owned();
            for message in receipt["messages"].as_array().into_iter().flatten() {
                let Some(id) = message["id"].as_str() else {
                    continue;
                };
                actor_labels
                    .entry(id.to_owned())
                    .or_insert_with(|| label.clone());
                if receipt["workspace"].is_object() {
                    workspace_sources.insert(id.to_owned(), receipt["workspace"].clone());
                }
                if items.iter().any(|item| item.id == id) {
                    continue;
                }
                let mut message = message.clone();
                if message.get("type").is_none() {
                    message["type"] = "message".into();
                }
                if let Ok(item) = serde_json::from_value::<Resource>(message) {
                    items.push(item);
                }
            }
        }
        let mut turns: Vec<Resource> = parse("turns")?;
        turns.sort_by_key(|turn| {
            std::cmp::Reverse(
                turn.fields
                    .get("created_at")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            )
        });
        let plan = value
            .get("plan")
            .filter(|plan| !plan.is_null())
            .map(|plan| serde_json::from_value(plan.clone()).map_err(|_| "Invalid activity Plan"))
            .transpose()?;
        Ok(Self {
            workspace_threads: value["workspace_threads"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            browser_available: value["browser_available"].as_bool().unwrap_or(false),
            plan,
            session: serde_json::from_value(value["session"].clone())
                .map_err(|_| "Invalid activity Session")?,
            items,
            turns,
            artifacts: value
                .get("artifacts")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|_| "Invalid activity artifacts")?
                .unwrap_or_default(),
            runtime: serde_json::from_value(value["runtime"].clone())
                .map_err(|_| "Runtime information is unavailable.".into()),
            role: value["role"].as_str().map(ToOwned::to_owned),
            permissions: value
                .get("permissions")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|_| "Invalid activity permissions")?,
            cursor: value["cursor"].as_str().map(ToOwned::to_owned),
            actor_labels,
            actor_colors,
            replies,
            workspace_sources,
        })
    }

    pub fn turn(&self) -> Option<&Resource> {
        self.turns
            .iter()
            .find(|turn| turn.fields.get("subagent_id").is_none_or(Value::is_null))
    }

    pub fn turn_active(&self) -> bool {
        self.turn()
            .is_some_and(|turn| matches!(turn.text("status"), "queued" | "in_progress" | "waiting"))
    }

    pub fn actions(&self) -> Vec<Value> {
        self.session
            .fields
            .get("required_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }
}

pub(crate) fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

pub(crate) fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod activity_tests {
    use super::*;
    use serde_json::json;

    fn plan_call() -> Resource {
        serde_json::from_value(json!({
            "id":"call-item", "type":"function_call", "name":"rat_things_plan_update",
            "turn_id":"turn_1", "call_id":"call_1", "status":"completed"
        }))
        .unwrap()
    }

    #[test]
    fn saved_plan_revision_reads_host_results_and_ignores_conflict_heads() {
        for output in [
            json!("{\"plan\":{\"revision\":2,\"items\":[]}}"),
            json!([{"type":"input_text","text":"{\"plan\":{\"revision\":2,\"items\":[]}}"}]),
        ] {
            let item = serde_json::from_value(json!({
                "id":"result", "type":"function_call_output", "output":output
            }))
            .unwrap();
            assert_eq!(saved_plan_revision(&item), Some(2));
        }
        let failed = serde_json::from_value(json!({
            "id":"failed", "type":"function_call_output",
            "output":"{\"error\":{\"current_plan\":{\"revision\":3}}}"
        }))
        .unwrap();
        assert_eq!(saved_plan_revision(&failed), None);
    }

    #[test]
    fn a_generated_plan_call_does_not_claim_an_update_was_saved() {
        let items = [plan_call()];
        let rows = conversation_items(&items);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].plan_update, Some(PlanUpdateStatus::Updating));
    }

    #[test]
    fn plan_output_status_controls_the_single_visible_update() {
        for (status, expected) in [
            ("completed", PlanUpdateStatus::Updated),
            ("failed", PlanUpdateStatus::Failed),
            ("cancelled", PlanUpdateStatus::Failed),
            ("in_progress", PlanUpdateStatus::Updating),
        ] {
            let output = serde_json::from_value(json!({
                "id":"output-item", "type":"function_call_output",
                "turn_id":"turn_1", "call_id":"call_1", "status":status
            }))
            .unwrap();
            let items = [plan_call(), output];
            let rows = conversation_items(&items);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].item.id, "output-item");
            assert_eq!(rows[0].plan_update, Some(expected));
        }
    }

    #[test]
    fn plan_output_error_cannot_claim_success_even_with_completed_status() {
        let output = serde_json::from_value(json!({
            "id":"output-item", "type":"function_call_output", "name":"rat_things_plan_update",
            "turn_id":"turn_1", "call_id":"call_1", "status":"completed",
            "error":{"message":"Plan changed. Use the current revision."}
        }))
        .unwrap();
        let items = [output];
        let rows = conversation_items(&items);
        assert_eq!(rows[0].plan_update, Some(PlanUpdateStatus::Failed));
    }

    #[test]
    fn a_different_turns_tool_result_does_not_complete_a_plan_call() {
        let output = serde_json::from_value(json!({
            "id":"other-output", "type":"function_call_output",
            "turn_id":"turn_2", "call_id":"call_1", "status":"completed"
        }))
        .unwrap();
        let items = [plan_call(), output];
        let rows = conversation_items(&items);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].plan_update, Some(PlanUpdateStatus::Updating));
        assert_eq!(rows[1].plan_update, None);
    }

    #[test]
    fn pending_activity_messages_render_once_then_dedupe_after_materialization() {
        let activity = |items: Value| {
            json!({
                "cursor":"opaque.digest", "session":{"id":"sess_shared","object":"agent.session"},
                "items":items, "turns":[], "inputs":[], "runtime":{},
                "pending_inputs":[{"receipt_id":"receipt_1","messages":[{"id":"msg_1","role":"user","content":[{"type":"input_text","text":"Hi"}]}],"actor":{"label":"Morgan"}}]
            })
        };
        let pending = SessionSnapshot::from_activity(activity(json!([]))).unwrap();
        assert_eq!(pending.items.len(), 1);
        assert_eq!(pending.items[0].id, "msg_1");
        assert_eq!(
            pending.actor_labels.get("msg_1").map(String::as_str),
            Some("Morgan")
        );

        let durable = SessionSnapshot::from_activity(activity(json!([{
            "id":"msg_1", "type":"message", "role":"user", "content":[{"type":"input_text","text":"Hi"}]
        }]))).unwrap();
        assert_eq!(durable.items.len(), 1);
        assert_eq!(durable.items[0].id, "msg_1");
    }
}
