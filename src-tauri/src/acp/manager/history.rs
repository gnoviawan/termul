use super::*;

/// Normalize, durably persist, flush, and broadcast a locally generated title.
/// Used by the host-injected `set_session_title` MCP tool (host_mcp).
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
    let next_seq = persistence
        .append_local_title(&session_id, title.clone())
        .await
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

/// Durably record an agent switch (CAP-2) and broadcast the synthetic
/// `acp:agent_switch` marker to live clients. The `record_local_title`
/// precedent: the durable record is written through `SessionPersistence`
/// (writer-assigned seq), the flush establishes the durability boundary, and
/// the fan-out is live-only — `is_durable_event` excludes `agent_switch`, so
/// `WsRelaySink::emit` fans it out WITHOUT re-appending a second durable
/// record (ONE durable record per switch; the fold renders one separator).
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
    let next_seq = persistence
        .append_agent_switch(&session_id, record)
        .await
        .map_err(|error| {
            log::warn!(
                "[acp-switch] marker persistence failed for session {} ({} → {}): {error}",
                crate::logging::redact_session_id(&session_id),
                from_config_id,
                to_config_id
            );
            // Preserve the SessionNotFound classification: a catalog-known
            // session whose writer runtime is gone (post-restart recovered
            // session) must be distinguishable from a storage failure — the
            // WS handler maps this string to a typed `not_found` reply.
            match error {
                SessionPersistenceError::SessionNotFound
                | SessionPersistenceError::WriterStopped => {
                    "session writer unavailable".to_string()
                }
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
                from_config_id,
                to_config_id
            );
            "failed to flush agent switch marker".to_string()
        })?;
    let event = AgentSwitchEvent {
        agent_id: user_agent_id,
        session_id: SessionId::new(switch_session_id.clone()),
        from_config_id,
        to_config_id: to_config_id.clone(),
        new_session_id,
        summary_text,
    };
    events::fan_out(
        sinks,
        Some(event.session_id.0.as_str()),
        events::EVENT_AGENT_SWITCH,
        &event,
    );
    log::info!(
        "[acp-switch] marker persisted and broadcast for session {} ({} → {}, new session {}, seq={next_seq})",
        crate::logging::redact_session_id(&switch_session_id),
        event.from_config_id,
        to_config_id,
        crate::logging::redact_session_id(&event.new_session_id),
    );
    Ok(())
}
