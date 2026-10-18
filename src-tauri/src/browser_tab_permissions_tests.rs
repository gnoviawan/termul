use super::*;

#[test]
fn every_permission_kind_is_denied() {
    let kinds = [
        PermissionKind::Microphone,
        PermissionKind::Camera,
        PermissionKind::Geolocation,
        PermissionKind::Notifications,
        PermissionKind::ClipboardRead,
        PermissionKind::DisplayCapture,
        PermissionKind::Midi,
        PermissionKind::Sensors,
        PermissionKind::MediaKeySystemAccess,
        PermissionKind::LocalFonts,
        PermissionKind::WindowManagement,
        PermissionKind::PointerLock,
        PermissionKind::AutomaticDownloads,
        PermissionKind::FileSystemAccess,
        PermissionKind::Autoplay,
        PermissionKind::Other,
    ];
    for kind in kinds {
        assert_eq!(decide(kind), PermissionResponse::Deny, "{kind}");
    }
}
