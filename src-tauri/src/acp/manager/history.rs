use super::*;
use crate::web::sink::{record_host_event, HostRecordError, HostRecordFanout};

/// Normalize, durably persist, flush, and broadcast a locally generated title.
/// Used by the host-injected `set_session_title` MCP tool (host_mcp).
///
/// The durable `local_title_generated` record takes its seq from the relay's
/// single allocator (`record_host_event`) and reaches live clients under that
/// seq; the `session_info_update` twin that carries the title to the UI is an
/// ordinary relay event with the next seq.
pub(crate) async fn record_local_title(
    persistence: &SessionPersistence,
    sinks: &[Arc<dyn EventSink>],
    user_agent_id: AgentId,
    session_id: String,
    raw_title: String,
) -> Result<(), String> {
    let title = normalize_title(&raw_title);
    if title == "Untitled Chat" {
        return Err("title must not be empty".to_string());
    }
    let metadata = persistence.metadata(&session_id).map_err(|error| {
        log::warn!(
            "[acp-title] metadata lookup failed for session {}: {error}",
            crate::logging::redact_session_id(&session_id)
        );
        "could not read title metadata".to_string()
    })?;
    if metadata.title_source == Some(TitleSource::LocalAlias) {
        return Err("title is protected by a local alias".to_string());
    }
    if metadata.title.as_deref() == Some(title.as_str())
        && metadata.title_source == Some(TitleSource::BackgroundGenerated)
    {
        return Ok(());
    }
    let next_seq = record_host_event(
        sinks,
        &session_id,
        events::EVENT_LOCAL_TITLE_GENERATED,
        &serde_json::json!({ "sessionId": session_id, "title": title }),
        HostRecordFanout::RelayOnly,
    )
    .map_err(|error| {
        log::warn!(
            "[acp-title] title persistence failed for session {}: {error}",
            crate::logging::redact_session_id(&session_id)
        );
        "failed to persist title".to_string()
    })?;
    persistence
        .flush_session(&session_id)
        .await
        .map_err(|error| {
            log::warn!(
                "[acp-title] title flush failed for session {}: {error}",
                crate::logging::redact_session_id(&session_id)
            );
            "failed to flush title".to_string()
        })?;
    let event = SessionInfoUpdateEvent::title_only(
        user_agent_id,
        SessionId::new(session_id.clone()),
        Some(title.clone()),
    );
    events::fan_out(
        sinks,
        Some(event.session_id.0.as_str()),
        events::EVENT_SESSION_INFO_UPDATE,
        &event,
    );
    log::info!(
        "[acp-title] title persisted and broadcast for session {} (seq={next_seq}, title_len={} chars)",
        crate::logging::redact_session_id(&session_id),
        title.chars().count()
    );
    Ok(())
}

/// Durably record an agent switch (CAP-2) and broadcast the `acp:agent_switch`
/// marker to live clients. The record is ONE event: the relay's single seq
/// allocator numbers it (`record_host_event`), appends it to the durable log
/// and fans it out to relay subscribers under that same seq, so the durable
/// record and its live delivery can never disagree (and the fold renders one
/// separator). Other sinks (the desktop renderer) get the same event. The
/// flush afterwards is the durability boundary for the caller.
///
/// Boundary logging carries session ids + config ids only — never the
/// summary text (it may quote user content).
pub(crate) async fn record_agent_switch(
    persistence: &SessionPersistence,
    sinks: &[Arc<dyn EventSink>],
    user_agent_id: AgentId,
    session_id: String,
    record: AgentSwitchRecord,
) -> Result<(), String> {
    // Same field validation as the Tauri command layer: the WS path reaches
    // this function WITHOUT that pre-check, and a marker missing any
    // identity field is permanently unresolvable (CAP-7 reopen reads them) —
    // it must never reach the durable write.
    if session_id.trim().is_empty()
        || record.from_config_id.trim().is_empty()
        || record.to_config_id.trim().is_empty()
        || record.new_session_id.trim().is_empty()
    {
        return Err(
            "sessionId, fromConfigId, toConfigId, and newSessionId are required".to_string(),
        );
    }
    let to_config_id = record.to_config_id.clone();
    let from_config_id = record.from_config_id.clone();
    let new_session_id = record.new_session_id.clone();
    let summary_text = record.summary_text.clone();
    let switch_session_id = session_id.clone();
    let event = AgentSwitchEvent {
        agent_id: user_agent_id,
        session_id: SessionId::new(switch_session_id.clone()),
        from_config_id,
        to_config_id: to_config_id.clone(),
        new_session_id,
        summary_text,
    };
    let next_seq = record_host_event(
        sinks,
        event.session_id.0.as_str(),
        events::EVENT_AGENT_SWITCH,
        &event,
        HostRecordFanout::AllSinks,
    )
    .map_err(|error| {
        log::warn!(
            "[acp-switch] marker persistence failed for session {} ({} → {}): {error}",
            crate::logging::redact_session_id(&session_id),
            event.from_config_id,
            to_config_id
        );
        // Preserve the SessionNotFound classification: a catalog-known
        // session whose writer runtime is gone (post-restart recovered
        // session) must be distinguishable from a storage failure — the
        // WS handler maps this string to a typed `not_found` reply.
        match error {
            HostRecordError::Persistence(
                SessionPersistenceError::SessionNotFound | SessionPersistenceError::WriterStopped,
            ) => "session writer unavailable".to_string(),
            _ => "failed to persist agent switch marker".to_string(),
        }
    })?;
    persistence
        .flush_session(&session_id)
        .await
        .map_err(|error| {
            log::warn!(
                "[acp-switch] marker flush failed for session {} ({} → {}): {error}",
                crate::logging::redact_session_id(&session_id),
                event.from_config_id,
                to_config_id
            );
            "failed to flush agent switch marker".to_string()
        })?;
    // Chain edge for the history fold: the marker is the durable authority,
    // but a list-fold needs the reverse lookup (target → source), which a
    // marker scan cannot answer without reading every log. Stamp the new
    // session's index entry. Non-blocking: the fold heals on the renderer's
    // own projection / a later open, so an index-cache failure never fails
    // the recorded switch.
    if let Err(error) = persistence
        .note_continued_from(&event.new_session_id, &session_id)
        .await
    {
        log::warn!(
            "[acp-switch] continued_from stamp failed for session {} (source {}): {error}",
            crate::logging::redact_session_id(&event.new_session_id),
            crate::logging::redact_session_id(&session_id)
        );
    }
    log::info!(
        "[acp-switch] marker persisted and broadcast for session {} ({} → {}, new session {}, seq={next_seq})",
        crate::logging::redact_session_id(&switch_session_id),
        event.from_config_id,
        to_config_id,
        crate::logging::redact_session_id(&event.new_session_id),
    );
    Ok(())
}
