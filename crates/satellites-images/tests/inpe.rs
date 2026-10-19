use satellites_images::{normalize_stac_item, StacProvider};

#[test]
fn recorded_inpe_item_preserves_unknowns_and_real_asset_keys() {
    let item: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/inpe-cbers-item.json")).unwrap();
    let scene = normalize_stac_item(item.clone(), "inpe-cbers", &[]).unwrap();
    assert_eq!(StacProvider::inpe_cbers().unwrap().id(), "inpe-cbers");
    assert_eq!(
        scene.preview_url.as_deref(),
        item["assets"]["thumbnail"]["href"].as_str()
    );
    assert!(scene.assets.iter().any(|asset| asset.key == "tci"));
    assert_eq!(scene.access, "open");
    assert!(scene.assets.iter().all(|asset| asset.access == "unknown"));
    assert!(scene.mission.is_none());
    assert!(scene.gsd_meters.is_none());
    assert!(scene.cloud_cover_percent.is_none());
    assert_eq!(scene.raw, item);
}
