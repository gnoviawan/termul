use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::consent::{ConsentInput, ConsentProvenance, ConsentView, Namespace, ShownValue};
use super::convert::{check_remote_url, Launch, McpCatalogReason, OptionKind, RemoteTransport};
use super::form::{
    resolve, validate_inputs, Field, FieldTarget, FormModel, Phase, Resolved, Values,
};
use super::import::{check_import, import_form, parse_import, ImportedLaunch};
use super::resolved::{Provenance, ResolvedConfig, ValueSlot};
use super::search::{item_status, RunnerAvailability};
use super::snapshot::{LoadedCatalog, RegistryStatus};
use super::trust::launch_digest;
use super::McpCatalogError;

pub const PLAN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PLANS: usize = 256;
const MAX_PLANS_PER_CALLER: usize = 16;
/// Bounds what one plan request makes the host parse and retain.
pub const MAX_PLAN_REQUEST_BYTES: usize = 64 * 1024;

pub const NOT_FOUND: &str = "MCP_CATALOG_NOT_FOUND";
pub const IMPORT_INVALID: &str = "MCP_IMPORT_INVALID";
pub const PLAN_NOT_AVAILABLE: &str = "MCP_PLAN_NOT_AVAILABLE";
pub const PLAN_NOT_FOUND: &str = "MCP_PLAN_NOT_FOUND";
pub const PLAN_CONSUMED: &str = "MCP_PLAN_CONSUMED";
pub const PLAN_EXPIRED: &str = "MCP_PLAN_EXPIRED";
pub const PLAN_MISMATCH: &str = "MCP_PLAN_MISMATCH";
pub const PLAN_WRONG_CALLER: &str = "MCP_PLAN_WRONG_CALLER";
pub const PLAN_LIMIT: &str = "MCP_PLAN_LIMIT";
pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PlanSource {
    Catalog {
        name: String,
        version: String,
    },
    Import {
        json: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server: Option<String>,
    },
    Reapprove {
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Upgrade {
        #[serde(rename = "entryId")]
        entry_id: String,
        version: String,
    },
}

impl PlanSource {
    fn kind(&self) -> &'static str {
        match self {
            Self::Catalog { .. } => "catalog",
            Self::Import { .. } => "import",
            Self::Reapprove { .. } => "reapprove",
            Self::Upgrade { .. } => "upgrade",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanChoice {
    pub kind: OptionKind,
    pub index: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRequest {
    pub source: PlanSource,
    #[serde(default)]
    pub choice: Option<PlanChoice>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub source: PlanSource,
    #[serde(default)]
    pub choice: Option<PlanChoice>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub plan_id: String,
    pub launch_digest: String,
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallForm {
    pub source: PlanSource,
    pub choice: Option<PlanChoice>,
    pub title: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum FormReply {
    Form { form: InstallForm },
    Unsupported { reason: McpCatalogReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub plan_id: String,
    pub name: String,
    pub source: PlanSource,
    pub choice: Option<PlanChoice>,
    pub expires_at: String,
    pub config: ResolvedConfig,
    pub form: Vec<Field>,
    pub consent_view: ConsentView,
    pub launch_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum PlanReply {
    Plan { plan: Box<InstallPlan> },
    Unsupported { reason: McpCatalogReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretSlot {
    Env,
    Header,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSecret {
    pub slot: SecretSlot,
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for ResolvedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedSecret")
            .field("slot", &self.slot)
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub name: String,
    pub config: ResolvedConfig,
    pub secrets: Vec<ResolvedSecret>,
    pub provenance: Option<Provenance>,
    pub launch_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanCaller {
    Connection(String),
    Client(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BaseLaunch {
    Stdio {
        command: String,
        args: Vec<String>,
    },
    Remote {
        transport: RemoteTransport,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Described {
    name: String,
    title: String,
    base: BaseLaunch,
    model: FormModel,
    provenance: Option<Provenance>,
    consent_provenance: Option<ConsentProvenance>,
    deprecated: bool,
    from_file: bool,
}

type Outcome<T> = Result<Result<T, McpCatalogReason>, McpCatalogError>;

fn error(code: &'static str, message: impl Into<String>) -> McpCatalogError {
    McpCatalogError {
        code,
        message: message.into(),
    }
}

fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

fn describe_catalog(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    name: &str,
    version: &str,
    choice: Option<PlanChoice>,
) -> Outcome<Described> {
    let index = catalog
        .items
        .binary_search_by(|item| item.name.as_str().cmp(name))
        .map_err(|_| error(NOT_FOUND, format!("no catalog item named `{name}`")))?;
    let item = &catalog.items[index];
    if item.version != version {
        return Err(error(
            NOT_FOUND,
            format!(
                "the catalog holds version {} of `{name}`, not {version}",
                item.version
            ),
        ));
    }
    let Some(parsed) = &item.parsed else {
        return Ok(Err(McpCatalogReason::Unparseable));
    };
    let option = match choice {
        Some(choice) => parsed
            .options
            .iter()
            .find(|option| option.kind == choice.kind && option.index == choice.index)
            .ok_or_else(|| {
                error(
                    VALIDATION_ERROR,
                    format!("`{name}` has no {:?} option {}", choice.kind, choice.index),
                )
            })?,
        None => {
            let (_, _, default) = item_status(item, runners);
            let Some(default) = default else {
                return Ok(Err(McpCatalogReason::NoInstallOptions));
            };
            parsed
                .options
                .iter()
                .find(|option| option.kind == default.kind && option.index == default.index)
                .expect("the default option is one of the item's options")
        }
    };
    let launch = match &option.outcome {
        Ok(launch) => launch,
        Err(reason) => return Ok(Err(reason.clone())),
    };
    let server = &parsed.server;
    let (base, model, mutable_tag) = match launch {
        Launch::Stdio { runner, argv } => {
            if !runners.has(*runner) {
                return Ok(Err(McpCatalogReason::NeedsRuntime { runtime: *runner }));
            }
            let package = &server.packages[option.index];
            let model = FormModel::for_package(package)
                .map_err(|unresolved| error(VALIDATION_ERROR, unresolved.to_string()))?;
            let mutable_tag =
                package.registry_type == "oci" && !package.identifier.contains("@sha256:");
            (
                BaseLaunch::Stdio {
                    command: runner.command().to_string(),
                    args: argv.iter().skip(1).cloned().collect(),
                },
                model,
                mutable_tag,
            )
        }
        Launch::Remote { transport, .. } => {
            let model = FormModel::for_remote(&server.remotes[option.index])
                .map_err(|unresolved| error(VALIDATION_ERROR, unresolved.to_string()))?;
            (
                BaseLaunch::Remote {
                    transport: *transport,
                },
                model,
                false,
            )
        }
    };
    let registry_title = item.title.as_deref().unwrap_or_default();
    let short_name = item.name.rsplit('/').next().unwrap_or(&item.name);
    let mut entry_name = slug(registry_title);
    if entry_name.is_empty() {
        entry_name = slug(short_name);
    }
    let title = if registry_title.trim().is_empty() {
        item.name.clone()
    } else {
        registry_title.to_string()
    };
    Ok(Ok(Described {
        name: entry_name,
        title,
        base,
        model,
        provenance: Some(Provenance {
            name: item.name.clone(),
            version: item.version.clone(),
            kind: option.kind,
            index: option.index,
            repository_id: server
                .repository
                .as_ref()
                .and_then(|repository| repository.id.clone()),
        }),
        consent_provenance: Some(ConsentProvenance {
            namespace: Namespace::of(&item.name),
            repository_url: item.repository_url.clone(),
            version: item.version.clone(),
            mutable_tag,
            snapshot_fetched_at: catalog.fetched_at.clone(),
        }),
        deprecated: item.status == RegistryStatus::Deprecated,
        from_file: false,
    }))
}

fn describe_import(json: &str, server: Option<&str>) -> Outcome<Described> {
    let imported =
        parse_import(json, server).map_err(|reason| error(IMPORT_INVALID, reason.to_string()))?;
    if let Err(reason) = check_import(&imported) {
        return Ok(Err(reason));
    }
    let model = import_form(&imported);
    let base = match &imported.launch {
        ImportedLaunch::Stdio { command, .. } => BaseLaunch::Stdio {
            command: command.clone(),
            args: Vec::new(),
        },
        ImportedLaunch::Remote { transport, .. } => BaseLaunch::Remote {
            transport: *transport,
        },
    };
    Ok(Ok(Described {
        name: imported.name.clone(),
        title: imported.name,
        base,
        model,
        provenance: None,
        consent_provenance: None,
        deprecated: false,
        from_file: true,
    }))
}

fn describe(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    source: &PlanSource,
    choice: Option<PlanChoice>,
) -> Outcome<Described> {
    match source {
        PlanSource::Catalog { name, version } => {
            describe_catalog(catalog, runners, name, version, choice)
        }
        PlanSource::Import { json, server } => {
            if choice.is_some() {
                return Err(error(VALIDATION_ERROR, "an import has no option to choose"));
            }
            describe_import(json, server.as_deref())
        }
        PlanSource::Reapprove { .. } | PlanSource::Upgrade { .. } => Err(error(
            PLAN_NOT_AVAILABLE,
            format!(
                "`{}` plans need the host entry list, which this build does not have yet",
                source.kind()
            ),
        )),
    }
}

struct Assembled {
    config: ResolvedConfig,
    shown: Vec<ShownValue>,
    secrets: Vec<ResolvedSecret>,
}

fn assemble(
    described: &Described,
    values: &Values,
    phase: Phase,
) -> Result<Assembled, McpCatalogError> {
    let mut args = Vec::new();
    let mut env = Vec::new();
    let mut headers = Vec::new();
    let mut url = None;
    let mut shown = Vec::new();
    let mut secrets = Vec::new();
    for slot in &described.model.slots {
        let resolved = resolve(slot, values);
        match (&slot.target, resolved) {
            (FieldTarget::Argument { name, .. }, Resolved::Value { value, .. }) => {
                if let Some(name) = name {
                    args.push(name.clone());
                }
                args.push(value);
            }
            (FieldTarget::Argument { index, .. }, Resolved::Pending) => {
                return Err(error(
                    VALIDATION_ERROR,
                    format!("`arg/{index}` has no value"),
                ));
            }
            (
                FieldTarget::Env { name } | FieldTarget::Header { name },
                Resolved::Value { value, origin },
            ) => {
                let (slots, kind) = match slot.target {
                    FieldTarget::Env { .. } => (&mut env, SecretSlot::Env),
                    _ => (&mut headers, SecretSlot::Header),
                };
                slots.push(ValueSlot {
                    name: name.clone(),
                    is_secret: slot.is_secret,
                });
                shown.push(ShownValue {
                    name: name.clone(),
                    is_secret: slot.is_secret,
                    value: Some((value.clone(), origin)),
                });
                secrets.push(ResolvedSecret {
                    slot: kind,
                    name: name.clone(),
                    value,
                });
            }
            (FieldTarget::Env { name } | FieldTarget::Header { name }, Resolved::Pending) => {
                if matches!(phase, Phase::Commit) {
                    return Err(error(VALIDATION_ERROR, format!("`{name}` has no value")));
                }
                let slots = match slot.target {
                    FieldTarget::Env { .. } => &mut env,
                    _ => &mut headers,
                };
                slots.push(ValueSlot {
                    name: name.clone(),
                    is_secret: true,
                });
                shown.push(ShownValue {
                    name: name.clone(),
                    is_secret: true,
                    value: None,
                });
            }
            (FieldTarget::Url, Resolved::Value { value, .. }) => url = Some(value),
            (FieldTarget::Url, Resolved::Pending | Resolved::Omitted) => {
                return Err(error(VALIDATION_ERROR, "`url` has no value"));
            }
            (_, Resolved::Omitted) => {}
        }
    }
    let config = match &described.base {
        BaseLaunch::Stdio {
            command,
            args: base,
        } => ResolvedConfig::Stdio {
            command: command.clone(),
            args: base.iter().cloned().chain(args).collect(),
            env,
        },
        BaseLaunch::Remote { transport } => {
            let url = url.ok_or_else(|| error(VALIDATION_ERROR, "`url` has no value"))?;
            if let Err(reason) = check_remote_url(&url) {
                let code = serde_json::to_value(&reason)
                    .ok()
                    .and_then(|value| value["code"].as_str().map(str::to_string))
                    .unwrap_or_default();
                return Err(error(
                    VALIDATION_ERROR,
                    format!("the resolved URL is not allowed ({code})"),
                ));
            }
            match transport {
                RemoteTransport::Http => ResolvedConfig::Http { url, headers },
                RemoteTransport::Sse => ResolvedConfig::Sse { url, headers },
            }
        }
    };
    Ok(Assembled {
        config,
        shown,
        secrets,
    })
}

/// The digest names env and header slots but not their values (AD-7), so
/// commit also re-derives this view and refuses any value the user did not see.
fn consent_view(described: &Described, assembled: &Assembled) -> ConsentView {
    ConsentView::build(ConsentInput {
        config: &assembled.config,
        values: &assembled.shown,
        provenance: described.consent_provenance.clone(),
        deprecated: described.deprecated,
        from_file: described.from_file,
    })
}

struct StoredPlan {
    caller: PlanCaller,
    created_at: Instant,
    consumed: bool,
    described: Described,
    values: Values,
    digest: String,
    consent_view: ConsentView,
}

pub struct PlanStore {
    ttl: Duration,
    plans: Mutex<HashMap<String, StoredPlan>>,
}

impl Default for PlanStore {
    fn default() -> Self {
        Self::new(PLAN_TTL)
    }
}

impl PlanStore {
    #[must_use]
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            plans: Mutex::new(HashMap::new()),
        }
    }

    /// Drops expired plans, then the caller's own oldest plan while it holds
    /// its quota. Another caller's live plan is never evicted.
    fn make_room(
        &self,
        plans: &mut HashMap<String, StoredPlan>,
        caller: &PlanCaller,
    ) -> Result<(), McpCatalogError> {
        let ttl = self.ttl;
        plans.retain(|_, plan| plan.created_at.elapsed() < ttl);
        loop {
            let mine = plans.iter().filter(|(_, plan)| plan.caller == *caller);
            if mine.clone().count() < MAX_PLANS_PER_CALLER {
                break;
            }
            let Some(oldest) = mine
                .min_by_key(|(_, plan)| plan.created_at)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            plans.remove(&oldest);
        }
        if plans.len() >= MAX_PLANS {
            return Err(error(
                PLAN_LIMIT,
                "too many install plans are open; try again in a few minutes",
            ));
        }
        Ok(())
    }

    fn insert(&self, plan: StoredPlan) -> Result<(String, String), McpCatalogError> {
        let mut plans = self.plans.lock();
        self.make_room(&mut plans, &plan.caller)?;
        let plan_id = Uuid::new_v4().to_string();
        let expires_at = (Utc::now()
            + chrono::Duration::from_std(self.ttl).unwrap_or(chrono::Duration::zero()))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
        plans.insert(plan_id.clone(), plan);
        Ok((plan_id, expires_at))
    }

    #[cfg(test)]
    pub(crate) fn count(&self) -> usize {
        self.plans.lock().len()
    }
}

fn log_label(plan_id: &str) -> String {
    plan_id.chars().take(8).collect()
}

pub(crate) fn describe_install(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    request: &FormRequest,
) -> Result<FormReply, McpCatalogError> {
    Ok(
        match describe(catalog, runners, &request.source, request.choice)? {
            Ok(described) => FormReply::Form {
                form: InstallForm {
                    source: request.source.clone(),
                    choice: request.choice,
                    title: described.title,
                    fields: described.model.fields,
                },
            },
            Err(reason) => FormReply::Unsupported { reason },
        },
    )
}

pub(crate) fn plan_install(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    store: &PlanStore,
    request: &PlanRequest,
    caller: PlanCaller,
) -> Result<PlanReply, McpCatalogError> {
    let import_bytes = match &request.source {
        PlanSource::Import { json, server } => json.len() + server.as_deref().map_or(0, str::len),
        _ => 0,
    };
    let input_bytes: usize = request.inputs.iter().map(|(k, v)| k.len() + v.len()).sum();
    if import_bytes + input_bytes > MAX_PLAN_REQUEST_BYTES {
        return Err(error(
            VALIDATION_ERROR,
            format!("the plan request exceeds {} KiB", MAX_PLAN_REQUEST_BYTES / 1024),
        ));
    }
    let described = match describe(catalog, runners, &request.source, request.choice)? {
        Ok(described) => described,
        Err(reason) => return Ok(PlanReply::Unsupported { reason }),
    };
    let values = validate_inputs(&described.model.fields, &request.inputs, Phase::Plan)
        .map_err(|message| error(VALIDATION_ERROR, message))?;
    let assembled = assemble(&described, &values, Phase::Plan)?;
    let digest = launch_digest(&assembled.config, described.provenance.as_ref());
    let consent_view = consent_view(&described, &assembled);
    let name = described.name.clone();
    let fields = described.model.fields.clone();
    let (plan_id, expires_at) = store.insert(StoredPlan {
        caller,
        created_at: Instant::now(),
        consumed: false,
        described,
        values,
        digest: digest.clone(),
        consent_view: consent_view.clone(),
    })?;
    log::info!(
        "[mcp-catalog] plan created plan={} source={} transport={} fields={}",
        log_label(&plan_id),
        request.source.kind(),
        consent_view.transport,
        fields.len()
    );
    Ok(PlanReply::Plan {
        plan: Box::new(InstallPlan {
            plan_id,
            name,
            source: request.source.clone(),
            choice: request.choice,
            expires_at,
            config: assembled.config,
            form: fields,
            consent_view,
            launch_digest: digest,
        }),
    })
}

fn take_live<'a>(
    store: &PlanStore,
    plans: &'a mut HashMap<String, StoredPlan>,
    plan_id: &str,
    caller: &PlanCaller,
) -> Result<&'a mut StoredPlan, McpCatalogError> {
    let Some(plan) = plans.get(plan_id) else {
        return Err(error(PLAN_NOT_FOUND, "no such plan"));
    };
    if plan.caller != *caller {
        return Err(error(
            PLAN_WRONG_CALLER,
            "the plan belongs to another connection",
        ));
    }
    if plan.created_at.elapsed() >= store.ttl {
        plans.remove(plan_id);
        return Err(error(PLAN_EXPIRED, "the plan has expired; plan again"));
    }
    Ok(plans.get_mut(plan_id).expect("looked up above"))
}

pub(crate) fn commit_install(
    store: &PlanStore,
    request: &CommitRequest,
    caller: &PlanCaller,
) -> Result<CommitResult, McpCatalogError> {
    let label = log_label(&request.plan_id);
    let result = commit_locked(store, request, caller);
    match &result {
        Ok(_) => log::info!("[mcp-catalog] plan committed plan={label}"),
        Err(error) => log::warn!(
            "[mcp-catalog] commit refused plan={label} code={}",
            error.code
        ),
    }
    result
}

fn commit_locked(
    store: &PlanStore,
    request: &CommitRequest,
    caller: &PlanCaller,
) -> Result<CommitResult, McpCatalogError> {
    let mut plans = store.plans.lock();
    let plan = take_live(store, &mut plans, &request.plan_id, caller)?;
    if plan.consumed {
        return Err(error(PLAN_CONSUMED, "the plan was already committed"));
    }
    if plan.digest != request.launch_digest {
        plans.remove(&request.plan_id);
        return Err(error(
            PLAN_MISMATCH,
            "the digest does not match the plan; plan again",
        ));
    }
    let secret_values = validate_inputs(
        &plan.described.model.fields,
        &request.secret_values,
        Phase::Commit,
    )
    .map_err(|message| error(VALIDATION_ERROR, message))?;
    let mut values = plan.values.clone();
    values.extend(secret_values);
    let assembled = assemble(&plan.described, &values, Phase::Commit)?;
    let digest = launch_digest(&assembled.config, plan.described.provenance.as_ref());
    if digest != plan.digest || consent_view(&plan.described, &assembled) != plan.consent_view {
        plans.remove(&request.plan_id);
        return Err(error(
            PLAN_MISMATCH,
            "the committed spec differs from the consented plan",
        ));
    }
    plan.consumed = true;
    Ok(CommitResult {
        name: plan.described.name.clone(),
        config: assembled.config,
        secrets: assembled.secrets,
        provenance: plan.described.provenance.clone(),
        launch_digest: digest,
    })
}

pub(crate) fn cancel_install(
    store: &PlanStore,
    request: &CancelRequest,
    caller: &PlanCaller,
) -> Result<(), McpCatalogError> {
    let mut plans = store.plans.lock();
    let Some(plan) = plans.get(&request.plan_id) else {
        return Ok(());
    };
    if plan.caller != *caller {
        log::warn!(
            "[mcp-catalog] cancel refused plan={} code={PLAN_WRONG_CALLER}",
            log_label(&request.plan_id)
        );
        return Err(error(
            PLAN_WRONG_CALLER,
            "the plan belongs to another connection",
        ));
    }
    plans.remove(&request.plan_id);
    log::info!(
        "[mcp-catalog] plan cancelled plan={}",
        log_label(&request.plan_id)
    );
    Ok(())
}
