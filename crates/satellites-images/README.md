# satellites-images (Rust)

Requires Rust 1.88 or newer with the committed lockfile.

Async Rust discovery client for published STAC satellite scenes and planned acquisitions. Supports Earth Search, Planetary Computer, Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC (STAC), plus bespoke ASF SAR and JAXA G-Portal adapters, and official ESA Sentinel-1/2 planned-acquisition plans.

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

`StacProvider::inpe_cbers()` searches INPE's Brazil-focused visual collection; set
`query.collections = vec!["CB4A-WPM-PCA-FUSED-1".into()]` before searching.
`AsfProvider::new(&["SENTINEL-1", "NISAR", "ALOS-2"])` opts into additional radar
missions. See [live checks and metadata limitations](../../docs/FREE_SOURCES_REVIEW.md).

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

Completeness requires all expected providers to finish without errors or truncation.
`AvailabilityAccumulator::expect_provider` registers providers before streaming;
`mark_error` records failures. `SatelliteCatalog::availability` retains partial pages
and continues with the remaining providers, including after bespoke-adapter failures.

## Maxar public releases

`maxar_open_data()` returns a `MaxarProvider` for anonymous, selected event releases.
Set `query.collections = vec!["maxar-open-data".into()]`, or provide event release
IDs, then call `search_pages`. Register it as `CatalogProvider::Maxar` for aggregation.
The default total budget is 2000 metadata documents (`with_max_documents`), with at
most 100 documents per page. Pending work sets `has_next`. Assets are not fetched.
See [limits, licence and live evidence](../../docs/PUBLIC_PREVIEWS.md).
