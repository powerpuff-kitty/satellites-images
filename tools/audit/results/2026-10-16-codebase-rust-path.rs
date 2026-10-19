use satellites_images::{SearchQuery, StacProvider};
fn main() {
    let base = std::env::args().nth(1).unwrap();
    let provider = StacProvider::new("audit", &base).unwrap();
    let mut query = SearchQuery::new(0.0, 0.0, 1000.0, "2025-01-01", "2025-01-01").unwrap();
    query.collections = vec!["a".into()];
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let pages = runtime.block_on(provider.search_pages(&query)).unwrap();
    println!("SDK returned {} page(s)", pages.len());
}
