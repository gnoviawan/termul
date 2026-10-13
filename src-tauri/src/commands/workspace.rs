use std::sync::Arc;

// ============================================================================
// Host-owned ACP catalog and install stores (CAP-6)
// ============================================================================

/// Tauri state wrapper for the host-owned `AcpCatalogService` (CAP-6 / Story
/// 8). `None` degrades to `ACP_CATALOG_UNAVAILABLE` (the desktop could not
/// open the catalog root at startup). Held as `Option<Arc<…>>` so the
/// desktop's degraded path is graceful, not a boot failure.
#[derive(Default)]
pub struct HostAcpCatalogStore(Option<Arc<crate::acp::AcpCatalogService>>);

impl HostAcpCatalogStore {
    /// Construct from an already-opened `AcpCatalogService` (`None` for
    /// degraded mode — the desktop could not open the store at startup).
    #[must_use]
    pub fn new(service: Option<Arc<crate::acp::AcpCatalogService>>) -> Self {
        Self(service)
    }

    /// Access the inner `AcpCatalogService` (`None` in degraded mode).
    /// Callers that need to clone the `Arc` should `.as_ref().map(Arc::clone)`.
    #[must_use]
    pub(crate) fn store(&self) -> Option<&Arc<crate::acp::AcpCatalogService>> {
        self.0.as_ref()
    }
}

/// Tauri state wrapper for the host-owned `AcpInstallService` (CAP-6 / Story
/// 9). Mirrors `HostAcpCatalogStore`: `None` degrades to
/// `ACP_INSTALL_UNAVAILABLE` (the desktop could not open the install root at
/// startup). Held as `Option<Arc<…>>` so the desktop's degraded path is
/// graceful, not a boot failure.
#[derive(Default)]
pub struct HostAcpInstallStore(Option<Arc<crate::acp::install::AcpInstallService>>);

impl HostAcpInstallStore {
    /// Construct from an already-opened `AcpInstallService` (`None` for
    /// degraded mode — the desktop could not open the store at startup).
    #[must_use]
    pub fn new(service: Option<Arc<crate::acp::install::AcpInstallService>>) -> Self {
        Self(service)
    }

    /// Access the inner `AcpInstallService` (`None` in degraded mode).
    /// Callers that need to clone the `Arc` should `.as_ref().map(Arc::clone)`.
    #[must_use]
    pub(crate) fn store(&self) -> Option<&Arc<crate::acp::install::AcpInstallService>> {
        self.0.as_ref()
    }
}
