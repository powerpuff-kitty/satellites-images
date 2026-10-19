//! Shared contracts against either the source crate or an unpacked .crate artifact.
use satellites_images::{
    summarize_availability, AvailabilityAccumulator, Error, MaxarProvider, SearchPage, SearchQuery,
    StacProvider,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

fn assert_json_equal(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) if a.is_f64() || b.is_f64() => {
            // JSON has one numeric type: 10 and 10.0 express the same value.
            assert_eq!(a.as_f64(), b.as_f64(), "{path}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json_equal(a, b, &format!("{path}[{index}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: object length");
            assert!(
                a.keys().all(|key| b.contains_key(key)),
                "{path}: object keys"
            );
            for (key, value) in a {
                assert_json_equal(value, &b[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Value, String> {
    // Accepted sockets can inherit O_NONBLOCK on macOS; fragmented HTTP bodies must wait.
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end;
    loop {
        let count = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Request ended before its headers".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|slice| slice == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if bytes.len() > 65536 {
            return Err("Request headers too large".into());
        }
    }
    let headers = String::from_utf8(bytes[..header_end].to_vec()).map_err(|e| e.to_string())?;
    let first: Vec<_> = headers
        .lines()
        .next()
        .ok_or("Missing request line")?
        .split_whitespace()
        .collect();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if length > 65536 {
        return Err("Request body too large".into());
    }
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Request body was incomplete".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + length])
            .map_err(|e| e.to_string())?
    };
    Ok(json!({"method":first[0],"path":first[1],"body":body}))
}

fn server(responses: Vec<Value>) -> (String, JoinHandle<Result<Vec<Value>, String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Bind mock catalogue");
    let origin = format!("http://{}", listener.local_addr().expect("Mock address"));
    listener
        .set_nonblocking(true)
        .expect("Nonblocking mock listener");
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut requests = Vec::new();
        for body in responses {
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => return Err(format!("Missing expected catalogue request: {e}")),
                }
            };
            requests.push(read_request(&mut stream)?);
            let body = body.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).map_err(|e| e.to_string())?;
        }
        Ok(requests)
    });
    (origin, handle)
}

fn canonical_urls(value: &mut Value, origin: &str) {
    match value {
        Value::String(text) => {
            if text.starts_with(origin) {
                *text = text.replacen(origin, "https://conformance.test", 1);
            }
        }
        Value::Array(values) => {
            for item in values {
                canonical_urls(item, origin);
            }
        }
        Value::Object(values) => {
            for item in values.values_mut() {
                canonical_urls(item, origin);
            }
        }
        _ => {}
    }
}

pub async fn check_conformance(fixture: &Value) -> usize {
    assert_eq!(
        fixture["version"],
        json!(1),
        "Unsupported conformance fixture version"
    );
    let cases = fixture["stacCases"].as_array().expect("STAC cases");
    assert!(!cases.is_empty(), "Conformance cases cannot be empty");
    for scenario in cases {
        let label = scenario["name"].as_str().expect("Case name");
        let q = &scenario["query"];
        let mut query = SearchQuery::for_aoi(
            q["aoi"].clone(),
            q["from"].as_str().unwrap(),
            q["to"].as_str().unwrap(),
        )
        .unwrap();
        query.collections = q["collections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        query.limit = q["limit"].as_u64().unwrap() as usize;
        query.max_pages = q["maxPages"].as_u64().unwrap() as usize;
        let (origin, handle) = server(scenario["responses"].as_array().unwrap().clone());
        let provider = StacProvider::new(fixture["providerId"].as_str().unwrap(), &origin).unwrap();
        let result = provider.search_pages(&query).await;
        let requests = handle
            .join()
            .expect("Mock catalogue thread")
            .unwrap_or_else(|error| panic!("{label}: mock requests: {error}"));
        let pages = result.unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_json_equal(
            &json!(requests),
            &scenario["expectedRequests"],
            &format!("{label}: requests"),
        );
        assert_json_equal(
            &json!(pages),
            &scenario["expectedPages"],
            &format!("{label}: pages"),
        );
        assert_json_equal(
            &json!(summarize_availability(&pages).unwrap()),
            &scenario["expectedSummary"],
            &format!("{label}: summary"),
        );
    }
    let maxar = fixture["maxarCases"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for scenario in &maxar {
        let label = scenario["name"].as_str().unwrap();
        let q = &scenario["query"];
        let mut query = SearchQuery::for_aoi(
            q["aoi"].clone(),
            q["from"].as_str().unwrap(),
            q["to"].as_str().unwrap(),
        )
        .unwrap();
        query.collections = q["collections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        query.limit = q["limit"].as_u64().unwrap() as usize;
        query.max_pages = q["maxPages"].as_u64().unwrap() as usize;
        let (origin, handle) = server(scenario["responses"].as_array().unwrap().clone());
        let provider = MaxarProvider::with_catalog_url(&format!("{origin}/events/catalog.json"))
            .unwrap()
            .with_max_documents(
                scenario["options"]["maxDocuments"].as_u64().unwrap_or(2000) as usize
            )
            .unwrap();
        let (pages, error) = provider.search_pages_partial(&query).await;
        if scenario["expectedError"] == "UNSAFE_NEXT_LINK" {
            assert!(
                matches!(error, Some(Error::UnsafeNextLink)),
                "{label}: {error:?}"
            );
        } else {
            assert!(error.is_none(), "{label}: {error:?}");
        }
        let requests = handle.join().expect("Static catalogue thread").unwrap();
        assert_json_equal(
            &json!(requests),
            &scenario["expectedRequests"],
            &format!("{label}: requests"),
        );
        let mut actual = json!(pages);
        canonical_urls(&mut actual, &origin);
        assert_json_equal(
            &actual,
            &scenario["expectedPages"],
            &format!("{label}: pages"),
        );
        assert_eq!(
            summarize_availability(&pages).unwrap().complete,
            pages.last().is_some_and(|page| !page.has_next),
            "{label}: completeness"
        );
    }
    let availability = fixture["availabilityCases"]
        .as_array()
        .expect("Availability cases");
    assert!(
        !availability.is_empty(),
        "Conformance cases cannot be empty"
    );
    for scenario in availability {
        let mut accumulator = AvailabilityAccumulator::new();
        for id in scenario["expectedProviders"].as_array().unwrap() {
            accumulator.expect_provider(id.as_str().unwrap());
        }
        let pages: Vec<SearchPage> = serde_json::from_value(scenario["pages"].clone()).unwrap();
        for page in &pages {
            accumulator.add_page(page).unwrap();
        }
        for id in scenario["erroredProviders"].as_array().unwrap() {
            accumulator.mark_error(id.as_str().unwrap());
        }
        assert_json_equal(
            &json!(accumulator.summary()),
            &scenario["expectedSummary"],
            &format!("{}: summary", scenario["name"]),
        );
    }
    cases.len() + availability.len() + maxar.len()
}
