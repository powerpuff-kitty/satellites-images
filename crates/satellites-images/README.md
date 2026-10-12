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

Read-only catalogue client. Assets have unknown download entitlements until separately verified. `upcoming()` intentionally fails because future planning is not yet implemented.
