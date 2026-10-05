use super::*;

#[test]
fn test_compare_versions() {
    assert_eq!(
        compare_versions("1.0.0", "1.0.0"),
        std::cmp::Ordering::Equal
    );
    assert_eq!(compare_versions("1.0.0", "1.0.1"), std::cmp::Ordering::Less);
    assert_eq!(
        compare_versions("1.0.1", "1.0.0"),
        std::cmp::Ordering::Greater
    );
    assert_eq!(
        compare_versions("1.2.0", "1.10.0"),
        std::cmp::Ordering::Less
    );
    assert_eq!(
        compare_versions("2.0.0", "1.9.9"),
        std::cmp::Ordering::Greater
    );
}

#[test]
fn test_version_to_parts() {
    assert_eq!(version_to_parts("1.2.3"), (1, 2, 3));
    assert_eq!(version_to_parts("0.0.0"), (0, 0, 0));
    assert_eq!(version_to_parts("2.10.5"), (2, 10, 5));
}
