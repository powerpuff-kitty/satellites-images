//! Network-free micro-benchmarks for the crate's CPU-bound hot paths.
//!
//! Run with: cargo run --release --example bench
use satellites_images::{
    coverage_percent, normalize_asf_feature, normalize_jaxa_feature, normalize_stac_item, polygon_boxes,
    summarize_availability, SearchPage, Scene,
};
use serde_json::json;
use std::time::Instant;

fn bench<F: FnMut()>(name: &str, iterations: u32, mut f: F) {
    for _ in 0..(iterations / 10).max(1) {
        f();
    }
    let start = Instant::now();
    for _ in 0..iterations {
        f();
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{:<34} {:>8} ops  {:>9.1} ms  {:>11.0} ops/s",
        name, iterations, ms, iterations as f64 / (ms / 1000.0)
    );
}

fn main() {
    let polygon = json!({"type":"Polygon","coordinates":[[[116.0,-8.7],[116.3,-8.7],[116.3,-8.4],[116.0,-8.4],[116.0,-8.7]]]});
    let antimeridian = json!({"type":"Polygon","coordinates":[[[179.9,-1],[-179.9,-1],[-179.9,1],[179.9,1],[179.9,-1]]]});
    let boxes = polygon_boxes(&polygon).unwrap();

    bench("polygon_boxes", 100_000, || {
        let _ = polygon_boxes(&polygon).unwrap();
    });
    bench("polygon_boxes(antimeridian)", 100_000, || {
        let _ = polygon_boxes(&antimeridian).unwrap();
    });
    bench("coverage_percent", 100_000, || {
        let _ = coverage_percent(Some(&vec![116.1, -8.6, 116.2, -8.5]), &boxes);
    });

    let mut pages: Vec<SearchPage> = Vec::new();
    for p in 0..50u32 {
        let mut items: Vec<Scene> = Vec::new();
        for i in 0..100u32 {
            let day = format!("2025-03-{:02}", (i % 28) + 1);
            let item = json!({"id":format!("p{p}-{i}"),"collection":"sentinel-2-l2a",
                "properties":{"datetime":format!("{day}T02:00:00Z"),"platform":"sentinel-2a"}});
            items.push(normalize_stac_item(item, "earth-search", &[]).unwrap());
        }
        pages.push(SearchPage { provider_id: "earth-search".into(), items, page_number: (p + 1) as usize, has_next: p < 49, matched: None });
    }
    bench("summarize_availability 50x100", 200, || {
        let _ = summarize_availability(&pages).unwrap();
    });

    let jaxa = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[140.88,46.45],[141.0,46.5],[140.9,46.6],[140.88,46.45]]]},
        "properties":{"identifier":"GC1SG1_x","beginPosition":"2021-07-07T00:07:08.58Z","platformShortName":"GCOM-C",
            "product":{"fileName":"https://gportal.jaxa.jp/x.h5"},"browse":[{"fileName":"https://gportal.jaxa.jp/x.jpg"}],
            "gpp":{"cloudCoverPercentage":"6"}}});
    let asf = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.1,-8.6]},
        "properties":{"granuleName":"S1A_x","startTime":"2025-01-10T02:00:00Z","platform":"Sentinel-1",
            "browse":["https://example.test/b.png"],"downloadUrl":"https://x/y.zip"}});
    bench("normalize_jaxa_feature", 100_000, || {
        let _ = normalize_jaxa_feature(&jaxa, "jaxa-gportal").unwrap();
    });
    bench("normalize_asf_feature", 100_000, || {
        let _ = normalize_asf_feature(&asf, "asf-vertex").unwrap();
    });
}
