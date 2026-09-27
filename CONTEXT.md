# Termul

Termul is a Tauri 2 desktop app with a React/TypeScript renderer and Rust runtime: a terminal-based agent chat client that spawns external AI coding agents over the Agent Client Protocol (ACP) and shares them across desktop and browser surfaces.

## Language

### ACP agent catalog & updates

**ACP Registry**:
The upstream catalog of ACP agents (id, name, version, distribution) served from the ACP CDN. The protocol itself has no update mechanism; distribution happens entirely through this catalog.
_Avoid_: marketplace, store

**Bundled Registry**:
The frozen registry snapshot shipped inside the app; the default trusted source for agent launch data.
_Avoid_: local registry, built-in catalog

**Remote Snapshot**:
A freshly fetched registry snapshot from the CDN. Advisory only: it never changes what Termul spawns until the user applies it.
_Avoid_: latest registry, live catalog

**Applied Registry**:
A Remote Snapshot the user explicitly opted into. It governs which agent versions and distribution metadata Termul derives launch configs from.
_Avoid_: active CDN, promoted snapshot

**Agent Catalog**:
The host-resolved view of the active registry: per OS/arch availability, runtime detection, and install state.
_Avoid_: registry (it is derived, not the source), agent list

**Persisted Agent Config**:
A saved agent launch configuration that takes precedence over registry-derived data. Registry updates do not touch it unless the user applies an update.
_Avoid_: stored agent, saved config

**Pinned Version**:
The exact agent version embedded in a launch spec (e.g. a package reference). Termul pins exact versions rather than floating ranges.
_Avoid_: locked version, semver range

**Updatable Agent**:
A registry agent with a trusted version source: an npx/uvx Pinned Version or a host-installed binary recorded in the install manifest.
_Avoid_: managed agent, auto-update agent

**Custom Agent**:
A user-supplied agent configuration outside the registry. It has no version source and is never updatable.
_Avoid_: manual agent, user agent

**Update Check**:
Advisory detection of version drift between the active registry and the latest Remote Snapshot. It never changes spawn behavior.
_Avoid_: update scan, refresh

**Update Application**:
The user-initiated act of overwriting the registry-derived fields of a Persisted Agent Config with data from the Applied Registry. User-added environment values are preserved.
_Avoid_: Agent Install, sync, upgrade

**Agent Install**:
The user-initiated installation of a registry-pinned ACP agent distribution into a Termul-managed cache on the host that runs the agent. For Claude ACP, this installs only the npm adapter package; the separate Claude Code CLI remains an operator-installed prerequisite.
_Avoid_: global install, install on the browser client, Update Application

### Iconography

**Functional UI icon**:
A symbol that represents an action, state, or navigation item in Termul’s interface.
_Avoid_: brand mark, file-type icon

**File-type icon**:
A symbol used to identify a file or folder category in a file tree.
_Avoid_: functional UI icon

**Brand mark**:
A logo or identity symbol belonging to Termul, an operating system, or a third-party agent/provider.
_Avoid_: functional UI icon