use crate::model::{
    Collection, ModelCatalog, Page, Resource, SESSION_ARCHIVED_KEY, SessionSnapshot, path_segment,
};
use reqwest::{Method, Url, blocking::Client};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const JSON_LIMIT: u64 = 16 * 1024 * 1024;
const PAGE_LIMIT: usize = 1_000;

pub(crate) enum Task {
    UpdateSessionMetadata {
        id: String,
        key: String,
        value: Option<String>,
    },
    Models,
    Templates,
    SetSessionArchived {
        id: String,
        archived: bool,
    },
    List {
        collection: Collection,
        after: Option<String>,
    },
    Detail {
        collection: Collection,
        id: String,
    },
    Snapshot {
        id: String,
    },
    Credentials {
        vault_id: String,
    },
    Mutation {
        path: String,
        method: Method,
        body: Option<Zeroizing<String>>,
        idempotency_key: Option<String>,
        secret: bool,
    },
    Download {
        path: String,
        filename: String,
    },
    DownloadTo {
        path: String,
        destination: PathBuf,
    },
}

pub(crate) enum Data {
    Models(ModelCatalog),
    Templates(Vec<Resource>),
    Page(Page),
    Resource(Resource),
    Snapshot(SessionSnapshot),
    Credentials(Vec<Resource>),
    Mutation(Value),
    Download(Option<PathBuf>),
}

pub(crate) struct Completion {
    pub id: u64,
    pub result: Result<Data, String>,
}

struct Job {
    id: u64,
    task: Task,
    repaint: egui::Context,
}

pub(crate) struct Worker {
    jobs: SyncSender<Job>,
    pub completions: Receiver<Completion>,
    next_id: u64,
}

impl Worker {
    pub fn new(endpoint: String, token: String) -> Result<Self, String> {
        let api = Arc::new(Api::new(endpoint, token)?);
        let (jobs, incoming) = mpsc::sync_channel::<Job>(4);
        let (completed, completions) = mpsc::channel();
        let incoming = Arc::new(Mutex::new(incoming));
        for index in 0..2 {
            let api = Arc::clone(&api);
            let incoming = Arc::clone(&incoming);
            let completed = completed.clone();
            std::thread::Builder::new()
                .name(format!("console-http-{index}"))
                .spawn(move || {
                    loop {
                        let Ok(job) = incoming.lock().expect("worker queue lock").recv() else {
                            break;
                        };
                        let result = api.execute(job.task);
                        if completed.send(Completion { id: job.id, result }).is_err() {
                            break;
                        }
                        job.repaint.request_repaint();
                    }
                })
                .map_err(|_| "Could not start the console request worker".to_owned())?;
        }
        Ok(Self {
            jobs,
            completions,
            next_id: 0,
        })
    }

    pub fn submit(&mut self, task: Task, ctx: &egui::Context) -> Result<u64, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.jobs
            .try_send(Job {
                id,
                task,
                repaint: ctx.clone(),
            })
            .map_err(|_| "Requests are busy. Please try again shortly.".to_owned())?;
        Ok(id)
    }
}

struct Api {
    endpoint: Url,
    token: Zeroizing<String>,
    client: Client,
}

impl Api {
    fn new(endpoint: String, token: String) -> Result<Self, String> {
        let token = Zeroizing::new(token);
        let endpoint =
            Url::parse(&endpoint).map_err(|_| "The console endpoint is invalid".to_owned())?;
        if endpoint.scheme() != "http"
            || !matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            || endpoint.port().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || token.is_empty()
        {
            return Err("The console requires an authenticated loopback endpoint".into());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(REQUEST_DEADLINE)
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "Could not initialize the console HTTP client".to_owned())?;
        Ok(Self {
            endpoint,
            token,
            client,
        })
    }

    fn url(&self, path: &str) -> Result<Url, String> {
        if !path.starts_with("/api/v1/") || path.contains('#') {
            return Err("Invalid console request path".into());
        }
        let url = self
            .endpoint
            .join(path)
            .map_err(|_| "Invalid console request path".to_owned())?;
        if url.origin() != self.endpoint.origin() || !url.path().starts_with("/api/v1/") {
            return Err("Invalid console request destination".into());
        }
        Ok(url)
    }

    fn request(
        &self,
        path: &str,
        method: Method,
        body: Option<Zeroizing<String>>,
        key: Option<&str>,
        secret: bool,
        deadline: Instant,
    ) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("The request timed out. Try refreshing.")?;
        let mut request = self
            .client
            .request(method.clone(), self.url(path)?)
            .bearer_auth(self.token.as_str())
            .timeout(remaining);
        if method != Method::GET {
            request = request.header("x-rat-console-request", "1");
        }
        if let Some(key) = key {
            request = request.header("idempotency-key", key);
        }
        if let Some(body) = body {
            let len = body.len() as u64;
            request = request.header("content-type", "application/json").body(
                reqwest::blocking::Body::sized(
                    SecretBody {
                        bytes: Zeroizing::new(body.as_bytes().to_vec()),
                        position: 0,
                    },
                    len,
                ),
            );
        }
        let response = request.send().map_err(request_error)?;
        let status = response.status();
        if status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        let mut bytes = Vec::new();
        response
            .take(JSON_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read the server response".to_owned())?;
        if bytes.len() as u64 > JSON_LIMIT {
            return Err("The server response exceeds the console size limit".into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| format!("The server returned an invalid response ({status})"))?;
        if !status.is_success() {
            if secret {
                return Err(format!(
                    "Credential request failed ({status}). Your draft is preserved."
                ));
            }
            return Err(value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("Request failed ({status})")));
        }
        Ok(value)
    }

    fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        deadline: Instant,
    ) -> Result<T, String> {
        serde_json::from_value(self.request(path, Method::GET, None, None, false, deadline)?)
            .map_err(|_| "The server response does not match the Agents API".to_owned())
    }

    fn pages(
        &self,
        path: &str,
        order: &str,
        active: bool,
        deadline: Instant,
    ) -> Result<Vec<Resource>, String> {
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        let mut cursors = HashSet::new();
        let mut after: Option<String> = None;
        for _ in 0..PAGE_LIMIT {
            let mut url = self.url(path)?;
            url.query_pairs_mut()
                .append_pair("limit", "100")
                .append_pair("order", order);
            if active {
                url.query_pairs_mut().append_pair("status", "active");
            }
            if let Some(after) = &after {
                url.query_pairs_mut().append_pair("after", after);
            }
            let page: Page = self.get(
                &format!("{}?{}", url.path(), url.query().unwrap_or_default()),
                deadline,
            )?;
            let last_id = page.data.last().map(|row| row.id.clone());
            for row in page.data {
                if seen.insert(row.id.clone()) {
                    rows.push(row);
                }
            }
            if !page.has_more {
                return Ok(rows);
            }
            let Some(last_id) = last_id else {
                return Err("The server returned an empty page with more results".into());
            };
            if !cursors.insert(last_id.clone()) {
                return Err("The server repeated its pagination cursor".into());
            }
            after = Some(last_id);
        }
        Err("This resource exceeds the console pagination limit".into())
    }

    fn update_session_metadata(
        &self,
        id: &str,
        key: &str,
        value: Option<String>,
        deadline: Instant,
    ) -> Result<Data, String> {
        let path = Collection::Sessions.resource_path(id);
        // Metadata updates replace the object; preserve unrelated fields from a fresh read.
        let session: Resource = self.get(&path, deadline)?;
        let mut metadata = session
            .fields
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(value) = value {
            metadata.insert(key.into(), value.into());
        } else {
            metadata.remove(key);
        }
        self.request(
            &path,
            Method::POST,
            Some(Zeroizing::new(json!({"metadata": metadata}).to_string())),
            None,
            false,
            deadline,
        )
        .map(Data::Mutation)
    }

    fn execute(&self, task: Task) -> Result<Data, String> {
        let deadline = Instant::now() + REQUEST_DEADLINE;
        match task {
            Task::SetSessionArchived { id, archived } => self.update_session_metadata(
                &id,
                SESSION_ARCHIVED_KEY,
                archived.then(|| "true".into()),
                deadline,
            ),
            Task::UpdateSessionMetadata { id, key, value } => {
                self.update_session_metadata(&id, &key, value, deadline)
            }
            Task::Templates => self
                .pages(Collection::Templates.path(), "desc", false, deadline)
                .map(Data::Templates),
            Task::Models => self.get("/api/v1/models", deadline).map(Data::Models),
            Task::List { collection, after } => {
                let mut url = self.url(collection.path())?;
                url.query_pairs_mut()
                    .append_pair("limit", "25")
                    .append_pair("order", "desc");
                if collection == Collection::Vaults {
                    url.query_pairs_mut().append_pair("status", "active");
                }
                if let Some(after) = after {
                    url.query_pairs_mut().append_pair("after", &after);
                }
                self.get(
                    &format!("{}?{}", url.path(), url.query().unwrap_or_default()),
                    deadline,
                )
                .map(Data::Page)
            }
            Task::Detail { collection, id } => self
                .get(&collection.resource_path(&id), deadline)
                .map(Data::Resource),
            Task::Credentials { vault_id } => self
                .pages(
                    &format!(
                        "{}/credentials",
                        Collection::Vaults.resource_path(&vault_id)
                    ),
                    "desc",
                    true,
                    deadline,
                )
                .map(Data::Credentials),
            Task::Snapshot { id } => {
                let path = Collection::Sessions.resource_path(&id);
                Ok(Data::Snapshot(SessionSnapshot {
                    session: self.get(&path, deadline)?,
                    items: self.pages(&format!("{path}/items"), "asc", false, deadline)?,
                    turns: self.pages(&format!("{path}/turns"), "desc", false, deadline)?,
                    artifacts: self.pages(&format!("{path}/artifacts"), "asc", false, deadline)?,
                }))
            }
            Task::Mutation {
                path,
                method,
                body,
                idempotency_key,
                secret,
            } => self
                .request(
                    &path,
                    method,
                    body,
                    idempotency_key.as_deref(),
                    secret,
                    deadline,
                )
                .map(Data::Mutation),
            Task::DownloadTo { path, destination } => {
                self.download(&path, &destination)?;
                Ok(Data::Download(Some(destination)))
            }
            Task::Download { path, filename } => {
                let filename = safe_filename(&filename);
                let Some(destination) = rfd::FileDialog::new()
                    .set_title("Save artifact")
                    .set_file_name(&filename)
                    .save_file()
                else {
                    return Ok(Data::Download(None));
                };
                self.download(&path, &destination)?;
                Ok(Data::Download(Some(destination)))
            }
        }
    }

    fn download(&self, path: &str, destination: &Path) -> Result<(), String> {
        let mut response = self
            .client
            .get(self.url(path)?)
            .bearer_auth(self.token.as_str())
            .send()
            .map_err(request_error)?;
        if !response.status().is_success() {
            return Err(format!("Artifact download failed ({})", response.status()));
        }
        let parent = destination
            .parent()
            .ok_or("Choose a file in an existing folder")?;
        let temporary = parent.join(format!(".rat-things-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not create the artifact file".to_owned())?;
        let result = (|| {
            std::io::copy(&mut response, &mut file)
                .map_err(|_| "Could not finish downloading the artifact".to_owned())?;
            file.flush()
                .and_then(|()| file.sync_all())
                .map_err(|_| "Could not save the artifact".to_owned())?;
            drop(file);
            std::fs::rename(&temporary, destination)
                .map_err(|_| "Could not replace the chosen artifact file".to_owned())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The request timed out. Your draft is preserved.".into()
    } else if error.is_connect() {
        "The local signer is unavailable. Restart the console to reconnect.".into()
    } else {
        "The request could not be completed. Your draft is preserved.".into()
    }
}

pub(crate) fn safe_filename(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = name
        .chars()
        .filter(|character| !character.is_control() && !matches!(character, '/' | '\\' | ':'))
        .take(200)
        .collect();
    if name.is_empty() || name == "." || name == ".." {
        "artifact".into()
    } else {
        name
    }
}

pub(crate) fn artifact_path(session_id: &str, artifact_id: &str) -> String {
    format!(
        "{}/artifacts/{}/content",
        Collection::Sessions.resource_path(session_id),
        path_segment(artifact_id)
    )
}

struct SecretBody {
    bytes: Zeroizing<Vec<u8>>,
    position: usize,
}

impl Read for SecretBody {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = output.len().min(self.bytes.len() - self.position);
        output[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_upstream_destinations_at_construction() {
        for endpoint in [
            "https://127.0.0.1:1234",
            "http://example.com:1234",
            "http://127.0.0.1:1234/api",
            "http://user@127.0.0.1:1234",
            "http://127.0.0.1:1234?token=secret",
        ] {
            assert!(Api::new(endpoint.into(), "private-token".into()).is_err());
        }
        assert!(Api::new("http://127.0.0.1:1234".into(), "private-token".into()).is_ok());
    }

    #[test]
    fn download_names_cannot_traverse_directories() {
        assert_eq!(safe_filename("../../private/output.md"), "output.md");
        assert_eq!(safe_filename("C:\\private\\output.md"), "output.md");
        assert_eq!(safe_filename(".."), "artifact");
        assert_eq!(safe_filename("bad\0name.txt"), "badname.txt");
    }
}
