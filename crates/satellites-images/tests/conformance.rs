#[path = "../../../tools/conformance/rust.rs"]
mod conformance;

#[tokio::test]
async fn shared_cross_language_contracts() {
    let fixture = serde_json::from_str(include_str!(
        "../../../tests/fixtures/conformance/stac.json"
    ))
    .unwrap();
    assert!(conformance::check_conformance(&fixture).await > 0);
}
