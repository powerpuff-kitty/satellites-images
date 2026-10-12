# satellites-images (Rust)

Async Rust discovery client for published STAC satellite scenes, currently supporting Element 84 Earth Search.

**Not published on crates.io.** Local use:

```toml
[dependencies]
satellites-images = { path = "../satellites-images/crates/satellites-images" }
tokio = { version = "1", features = ["full"] }
```

```rust
use satellites_images::{EarthSearch, SearchQuery};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let query = SearchQuery::new(-8.5833, 116.1167, 5000.0, "2025-01-01", "2025-02-01")?;
    let scenes = EarthSearch::default().search(&query).await?;
    for scene in scenes { println!("{} {}", scene.id, scene.acquired_at); }
    Ok(())
}
```

Future Sentinel-1/2 acquisition plans:

```rust
use satellites_images::{ESAPlansProvider, AcquisitionQuery};
# async fn check() -> Result<(), Box<dyn std::error::Error>> {
let query = AcquisitionQuery::new(-8.5833,116.1167,5000.0,14)?;
let planned = ESAPlansProvider::default().upcoming(&query).await?;
println!("{} planned datatakes", planned.len());
# Ok(())
# }
```

Read-only catalogue client. Assets have unknown download entitlements until separately verified. The ESA provider retrieves official KML planned swaths. Predictions, image guarantees, and non-ESA plans are not implemented.

## Availability aggregation

```rust
# async fn run() -> Result<(), Box<dyn std::error::Error>> {
let provider = satellites_images::EarthSearch::default();
let query = satellites_images::SearchQuery::new(0.0,0.0,1000.0,"2025-01-01","2025-01-31")?;
let summary = provider.availability(&query).await?;
println!("{} unique items, fully paginated: {}",summary.unique_items,summary.complete);
# Ok(())
```

Availability is built only from returned pages, not an exhaustive list of all imagery ever acquired by all satellite operators.
