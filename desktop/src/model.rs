use serde::Deserialize;
use serde_json::{Map, Value, json};

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
}

#[derive(Deserialize)]
pub(crate) struct Page {
    pub data: Vec<Resource>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Clone)]
pub(crate) struct SessionSnapshot {
    pub session: Resource,
    pub items: Vec<Resource>,
    pub turns: Vec<Resource>,
    pub artifacts: Vec<Resource>,
}

impl SessionSnapshot {
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
