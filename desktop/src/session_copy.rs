use crate::model::ModelCatalog;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct DestinationInput {
    pub endpoint: String,
    pub region: String,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct Destination {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub region: String,
}

impl DestinationInput {
    fn matches(&self, destination: &Destination) -> bool {
        reqwest::Url::parse(&self.endpoint).is_ok_and(|url| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && matches!(url.path(), "" | "/" | "/v1" | "/v1/")
                && format!("{}/v1", url.origin().ascii_serialization()) == destination.base_url
                && self.region == destination.region
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CopySource {
    pub id: String,
    pub model: String,
}

#[derive(Clone)]
pub(crate) struct CopyReview {
    pub source: CopySource,
    pub destination: Destination,
    pub model: String,
}

#[derive(Deserialize)]
struct DestinationModels {
    destination: Destination,
    models: ModelCatalog,
}

#[derive(Default)]
pub(crate) struct CopyDraft {
    pub source: Option<CopySource>,
    pub destination: DestinationInput,
    pub catalog: Option<ModelCatalog>,
    pub model: String,
    pub pending: Option<u64>,
    pub error: Option<String>,
    resolved: Option<Destination>,
}

impl CopyDraft {
    pub fn sync(&mut self, source: Option<CopySource>, destination: DestinationInput) {
        if self.destination != destination {
            self.destination = destination;
            self.catalog = None;
            self.resolved = None;
            self.model.clear();
            self.pending = None;
            self.error = None;
        }
        if self.source != source {
            self.source = source;
            self.model.clear();
        }
    }

    pub fn finish(&mut self, id: u64, result: Result<Value, String>) {
        if self.pending != Some(id) {
            return;
        }
        self.pending = None;
        let parsed = result.and_then(|value| {
            let result: DestinationModels = serde_json::from_value(value)
                .map_err(|_| "The destination model response is invalid.".to_owned())?;
            if !self.destination.matches(&result.destination) || result.models.data.is_empty() {
                return Err(
                    "The destination model response does not match this AWS workspace.".into(),
                );
            }
            Ok(result)
        });
        match parsed {
            Ok(result) => {
                if self.model.is_empty()
                    && let Some(source) = &self.source
                    && result
                        .models
                        .data
                        .iter()
                        .any(|model| model.id == source.model)
                {
                    self.model.clone_from(&source.model);
                }
                self.catalog = Some(result.models);
                self.resolved = Some(result.destination);
                self.error = None;
            }
            Err(error) => {
                self.error = Some(error);
            }
        }
    }

    pub fn review(&self) -> Option<CopyReview> {
        if self.pending.is_some() || self.error.is_some() {
            return None;
        }
        let source = self.source.clone()?;
        let destination = self.resolved.clone()?;
        if !self.destination.matches(&destination)
            || !self
                .catalog
                .as_ref()?
                .data
                .iter()
                .any(|model| model.id == self.model)
        {
            return None;
        }
        Some(CopyReview {
            source,
            destination,
            model: self.model.clone(),
        })
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CopyStatus {
    Preparing,
    Ready,
    Uploading,
    Importing,
    Complete,
    Failed,
}

impl CopyStatus {
    pub fn active(self) -> bool {
        matches!(self, Self::Preparing | Self::Uploading | Self::Importing)
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Preparing => "Preparing",
            Self::Ready => "Ready",
            Self::Uploading => "Uploading",
            Self::Importing => "Importing",
            Self::Complete => "Complete",
            Self::Failed => "Interrupted or failed",
        }
    }
}

#[derive(Clone, Deserialize)]
pub(crate) struct TransferPlan {
    #[serde(deserialize_with = "transfer_id")]
    pub id: uuid::Uuid,
    pub source_session_id: String,
    pub destination: Destination,
    pub status: CopyStatus,
    pub files: u64,
    pub bytes: u64,
    pub history_items: u64,
    pub uploaded_parts: u64,
    pub total_parts: u64,
    pub destination_session_id: Option<String>,
    pub error: Option<String>,
    pub source_model: Option<String>,
    pub model: Option<String>,
}

fn transfer_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<uuid::Uuid, D::Error> {
    uuid::Uuid::parse_str(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

impl TransferPlan {
    pub fn parse(value: Value, expected: Option<uuid::Uuid>) -> Result<Self, String> {
        let plan: Self = serde_json::from_value(value)
            .map_err(|_| "The saved copy response is invalid.".to_owned())?;
        let destination = DestinationInput {
            endpoint: plan.destination.base_url.clone(),
            region: plan.destination.region.clone(),
        };
        if expected.is_some_and(|id| id != plan.id)
            || !destination.matches(&plan.destination)
            || plan.uploaded_parts > plan.total_parts
            || plan.source_session_id.is_empty()
            || plan.status == CopyStatus::Complete
                && plan
                    .destination_session_id
                    .as_ref()
                    .is_none_or(String::is_empty)
        {
            return Err("The saved copy response does not match this copy.".into());
        }
        Ok(plan)
    }

    pub fn matches_review(&self, review: &CopyReview) -> bool {
        self.source_session_id == review.source.id
            && self.source_model.as_ref() == Some(&review.source.model)
            && self.destination == review.destination
            && self.model.as_ref() == Some(&review.model)
    }

    pub fn can_execute(&self) -> bool {
        matches!(self.status, CopyStatus::Ready | CopyStatus::Failed)
            && self
                .source_model
                .as_ref()
                .is_some_and(|model| !model.is_empty())
            && self.model.as_ref().is_some_and(|model| !model.is_empty())
    }
}

pub(crate) fn saved_copies(
    value: Value,
) -> Result<(Vec<TransferPlan>, Option<uuid::Uuid>), String> {
    let invalid = || "The saved copies response is invalid.".to_owned();
    if value["object"] != "list"
        || !value["has_more"].is_boolean()
        || !value
            .get("last_id")
            .is_some_and(|last| last.is_null() || last.is_string())
    {
        return Err(invalid());
    }
    let data = value["data"]
        .as_array()
        .filter(|data| data.len() <= 20)
        .ok_or_else(invalid)?;
    let plans = data
        .iter()
        .map(|plan| TransferPlan::parse(plan.clone(), None))
        .collect::<Result<Vec<_>, _>>()?;
    let last = value["last_id"]
        .as_str()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(|_| invalid())?;
    if plans.last().map(|plan| plan.id) != last
        || plans
            .iter()
            .enumerate()
            .any(|(index, plan)| plans[..index].iter().any(|previous| previous.id == plan.id))
        || value["has_more"] == true && last.is_none()
    {
        return Err(invalid());
    }
    Ok((
        plans,
        if value["has_more"] == true {
            last
        } else {
            None
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response() -> Value {
        json!({"destination":{"baseURL":"https://cloud.example/v1","region":"us-west-2"},
            "models":{"object":"list","data":[{"id":"cloud","object":"model"}],"default_model":"cloud"}})
    }

    #[test]
    fn absent_source_needs_an_explicit_destination_choice() {
        let mut draft = CopyDraft::default();
        draft.sync(
            Some(CopySource {
                id: "sess_local".into(),
                model: "local".into(),
            }),
            DestinationInput {
                endpoint: "https://cloud.example".into(),
                region: "us-west-2".into(),
            },
        );
        draft.pending = Some(1);
        draft.finish(1, Ok(response()));
        assert!(draft.model.is_empty());
        assert!(draft.review().is_none());
        draft.model = "cloud".into();
        assert_eq!(draft.review().unwrap().model, "cloud");
    }

    #[test]
    fn old_catalog_reply_does_not_clear_a_newer_request() {
        let mut draft = CopyDraft::default();
        draft.sync(
            None,
            DestinationInput {
                endpoint: "https://cloud.example".into(),
                region: "us-west-2".into(),
            },
        );
        draft.pending = Some(1);
        draft.sync(
            None,
            DestinationInput {
                endpoint: "https://other.example".into(),
                region: "us-west-2".into(),
            },
        );
        draft.pending = Some(2);
        draft.finish(1, Ok(response()));
        assert_eq!(draft.pending, Some(2));
        assert!(draft.catalog.is_none());
        draft.finish(2, Ok(response()));
        assert!(draft.catalog.is_none());
        assert!(draft.error.is_some());
    }

    #[test]
    fn refresh_does_not_substitute_for_a_removed_selected_model() {
        let mut draft = CopyDraft::default();
        draft.sync(
            Some(CopySource {
                id: "sess_local".into(),
                model: "cloud".into(),
            }),
            DestinationInput {
                endpoint: "https://cloud.example".into(),
                region: "us-west-2".into(),
            },
        );
        draft.pending = Some(1);
        draft.finish(1, Ok(response()));
        assert_eq!(draft.model, "cloud");
        let mut changed = response();
        changed["models"] = json!({"data":[{"id":"replacement"}],"default_model":"replacement"});
        draft.pending = Some(2);
        draft.finish(2, Ok(changed));
        assert_eq!(draft.model, "cloud");
        assert!(draft.review().is_none());
    }

    #[test]
    fn refresh_failure_keeps_the_catalog_and_choice_until_recovery() {
        let mut draft = CopyDraft::default();
        draft.sync(
            Some(CopySource {
                id: "sess_local".into(),
                model: "cloud".into(),
            }),
            DestinationInput {
                endpoint: "https://cloud.example".into(),
                region: "us-west-2".into(),
            },
        );
        draft.pending = Some(1);
        draft.finish(1, Ok(response()));
        draft.pending = Some(2);
        assert!(draft.catalog.is_some());
        assert!(draft.review().is_none());
        draft.finish(2, Err("Temporarily unavailable".into()));
        assert_eq!(draft.catalog.as_ref().unwrap().data[0].id, "cloud");
        assert_eq!(draft.model, "cloud");
        assert!(draft.resolved.is_some());
        assert!(draft.review().is_none());
        draft.pending = Some(3);
        draft.finish(3, Ok(response()));
        assert_eq!(draft.review().unwrap().model, "cloud");
        assert!(draft.error.is_none());
    }

    #[test]
    fn saved_copy_pages_require_a_valid_cursor_and_plan_shape() {
        assert!(
            saved_copies(json!({"object":"list","data":[],"has_more":false,"last_id":null}))
                .is_ok()
        );
        for page in [
            json!({"object":"list","data":[],"has_more":true,"last_id":null}),
            json!({"object":"list","data":[],"has_more":false,"last_id":42}),
            json!({"object":"list","data":[],"has_more":false}),
            json!({"object":"list","data":[{}],"has_more":false,"last_id":null}),
        ] {
            assert!(saved_copies(page).is_err());
        }
    }
}
