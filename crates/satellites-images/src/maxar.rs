//! Bounded static STAC traversal for selected anonymous Maxar event releases.
use super::*;

const ROOT: &str = "https://maxar-opendata.s3.amazonaws.com/events/catalog.json";
const ID: &str = "maxar-open-data";
#[derive(Clone)]
pub struct MaxarProvider {
    root: Url,
    client: Client,
    max_documents: usize,
}
fn timestamp(value: &Value) -> Option<String> {
    DateTime::parse_from_rfc3339(&value.as_str()?.replacen(' ', "T", 1))
        .ok()
        .map(|time| {
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}
fn boxes(value: &Value) -> Vec<[f64; 4]> {
    let Some(values) = value.as_array().filter(|v| v.len() == 4) else {
        return vec![];
    };
    let coordinates: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
    let Some(v) = coordinates.filter(|v| v.iter().all(|n| n.is_finite())) else {
        return vec![];
    };
    let (w, s, e, n) = (v[0], v[1], v[2], v[3]);
    if !(-180.0..=180.0).contains(&w)
        || !(-180.0..=180.0).contains(&e)
        || s < -90.0
        || n > 90.0
        || s > n
    {
        return vec![];
    }
    if w <= e {
        vec![[w, s, e, n]]
    } else {
        vec![[w, s, 180.0, n], [-180.0, s, e, n]]
    }
}
fn overlaps(value: &Value, areas: &[[f64; 4]]) -> bool {
    boxes(value).iter().any(|a| {
        areas
            .iter()
            .any(|b| a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1])
    })
}
impl MaxarProvider {
    pub fn new() -> Result<Self, Error> {
        Self::with_catalog_url(ROOT)
    }
    /// Override the static catalogue for a mirror or test server.
    pub fn with_catalog_url(catalog_url: &str) -> Result<Self, Error> {
        let root = Url::parse(catalog_url).map_err(|e| Error::InvalidProvider(e.to_string()))?;
        if (root.scheme() != "https"
            && !(root.scheme() == "http"
                && matches!(root.host_str(), Some("localhost" | "127.0.0.1"))))
            || !root.username().is_empty()
            || root.password().is_some()
            || root.query().is_some()
            || root.fragment().is_some()
        {
            return Err(Error::InvalidProvider("Invalid Maxar catalogue URL".into()));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            root,
            client,
            max_documents: 2000,
        })
    }
    pub fn with_max_documents(mut self, maximum: usize) -> Result<Self, Error> {
        if !(1..=10000).contains(&maximum) {
            return Err(Error::InvalidProvider(
                "max_documents must be 1..10000".into(),
            ));
        }
        self.max_documents = maximum;
        Ok(self)
    }
    pub fn id(&self) -> &str {
        ID
    }
    /// `collections` contains release IDs, or `maxar-open-data` for all releases.
    pub async fn search_pages_partial(
        &self,
        query: &SearchQuery,
    ) -> (Vec<SearchPage>, Option<Error>) {
        let mut pages = vec![];
        let error = self.traverse(query, &mut pages).await.err();
        (pages, error)
    }
    async fn traverse(
        &self,
        query: &SearchQuery,
        pages: &mut Vec<SearchPage>,
    ) -> Result<(), Error> {
        query.validate()?;
        let (areas, _) = resolve_areas(query)?;
        let start = format!("{}T00:00:00.000Z", query.start);
        let end = format!("{}T23:59:59.999Z", query.end);
        let directory = self
            .root
            .join(".")
            .map_err(|e| Error::InvalidProvider(e.to_string()))?
            .path()
            .to_string();
        let mut pending = vec![(self.root.clone(), None::<String>, None::<String>)];
        let mut scheduled = HashSet::from([self.root.to_string()]);
        let mut seen = HashSet::new();
        let (mut documents, mut page_documents, mut skipped) = (0, 0, 0);
        let mut items = vec![];
        while !pending.is_empty() && documents < self.max_documents && pages.len() < query.max_pages
        {
            let (href, inherited_release, inherited_license) = pending.pop().unwrap();
            let response = self
                .client
                .get(href.clone())
                .header("accept", "application/json")
                .send()
                .await?;
            if !response.status().is_success() {
                return Err(Error::Http(response.status().as_u16()));
            }
            let data = read_json_bounded(response, MAX_RESPONSE_BYTES).await?;
            documents += 1;
            page_documents += 1;
            let kind = data["type"].as_str().unwrap_or("");
            if !matches!(kind, "Catalog" | "Collection" | "Feature") {
                return Err(Error::InvalidResponse(
                    "Unsupported static STAC document".into(),
                ));
            }
            let release = inherited_release.clone().or_else(|| {
                (kind == "Collection")
                    .then(|| data["id"].as_str().map(str::to_string))
                    .flatten()
            });
            let license = data["license"]
                .as_str()
                .map(str::to_string)
                .or(inherited_license);
            let mut include = true;
            if kind == "Collection" {
                if let Some(bounds) = data["extent"]["spatial"]["bbox"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.iter().all(|b| !boxes(b).is_empty()))
                {
                    include = bounds.iter().any(|b| overlaps(b, &areas));
                }
                if let Some(intervals) =
                    data["extent"]["temporal"]["interval"]
                        .as_array()
                        .filter(|v| {
                            !v.is_empty()
                                && v.iter().all(|i| {
                                    i.as_array().is_some_and(|a| {
                                        a.len() == 2
                                            && a.iter()
                                                .all(|t| t.is_null() || timestamp(t).is_some())
                                    })
                                })
                        })
                {
                    include &= intervals.iter().any(|i| {
                        (i[0].is_null() || timestamp(&i[0]).unwrap() <= end)
                            && (i[1].is_null() || timestamp(&i[1]).unwrap() >= start)
                    });
                }
                if inherited_release.is_none()
                    && !query
                        .collections
                        .iter()
                        .any(|c| c == ID || Some(c) == release.as_ref())
                {
                    include = false;
                }
            }
            if kind == "Feature" {
                let at = timestamp(&data["properties"]["datetime"]);
                if data["id"].as_str().is_none_or(str::is_empty) || boxes(&data["bbox"]).is_empty()
                {
                    skipped += 1;
                } else if let Some(at) = at {
                    if at >= start && at <= end && overlaps(&data["bbox"], &areas) {
                        let mut prepared = data.clone();
                        if prepared["collection"].as_str().is_none_or(str::is_empty) {
                            prepared["collection"] = json!(release.as_deref().unwrap_or(ID));
                        }
                        prepared["properties"]["datetime"] = json!(at);
                        if let Some(value) = &license {
                            prepared["properties"]["license"] = json!(value);
                        }
                        if let Some(assets) = prepared["assets"].as_object_mut() {
                            for asset in assets.values_mut() {
                                if let Some(link) = asset["href"].as_str() {
                                    asset["href"] = json!(href
                                        .join(link)
                                        .map_err(|e| Error::InvalidResponse(e.to_string()))?
                                        .to_string());
                                }
                            }
                        }
                        let mut links = vec![json!({"rel":"self","href":href.as_str()})];
                        if license.as_deref() == Some("CC-BY-NC-4.0") {
                            links.push(json!({"rel":"license","href":"https://creativecommons.org/licenses/by-nc/4.0/"}));
                        }
                        for mut link in prepared["links"].as_array().cloned().unwrap_or_default() {
                            if let Some(path) = link["href"].as_str() {
                                link["href"] = json!(href
                                    .join(path)
                                    .map_err(|e| Error::InvalidResponse(e.to_string()))?
                                    .to_string());
                            }
                            links.push(link);
                        }
                        prepared["links"] = json!(links);
                        let mut scene = normalize_stac_item(prepared, ID, &areas)?;
                        scene.raw = data.clone();
                        if seen.insert((scene.collection.clone(), scene.id.clone())) {
                            items.push(scene);
                        }
                    }
                } else {
                    skipped += 1;
                }
            } else if include {
                let links = data["links"]
                    .as_array()
                    .filter(|v| v.len() <= 10000)
                    .ok_or_else(|| {
                        Error::InvalidResponse("Invalid static catalogue links".into())
                    })?;
                let mut queued = vec![];
                for link in links
                    .iter()
                    .filter(|l| matches!(l["rel"].as_str(), Some("child" | "item")))
                {
                    let path = link["href"].as_str().ok_or_else(|| {
                        Error::InvalidResponse("Static catalogue link lacks a URL".into())
                    })?;
                    let url = href
                        .join(path)
                        .map_err(|e| Error::InvalidResponse(e.to_string()))?;
                    if url.origin() != self.root.origin()
                        || !url.path().starts_with(&directory)
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.query().is_some()
                        || url.fragment().is_some()
                    {
                        return Err(Error::UnsafeNextLink);
                    }
                    if scheduled.insert(url.to_string()) {
                        queued.push((url, release.clone(), license.clone()));
                    }
                    if scheduled.len() > 100000 {
                        return Err(Error::InvalidResponse(
                            "Static catalogue has too many links".into(),
                        ));
                    }
                }
                pending.extend(queued.into_iter().rev());
            }
            if items.len() >= query.limit
                || page_documents >= 100
                || pending.is_empty()
                || documents == self.max_documents
            {
                pages.push(SearchPage {
                    provider_id: ID.into(),
                    items: std::mem::take(&mut items),
                    page_number: pages.len() + 1,
                    has_next: !pending.is_empty(),
                    matched: None,
                    skipped,
                });
                skipped = 0;
                page_documents = 0;
            }
        }
        Ok(())
    }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let (pages, error) = self.search_pages_partial(query).await;
        if let Some(error) = error {
            return Err(error);
        }
        Ok(pages)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self
            .search_pages(query)
            .await?
            .into_iter()
            .flat_map(|page| page.items)
            .collect())
    }
}
pub fn maxar_open_data() -> Result<MaxarProvider, Error> {
    MaxarProvider::new()
}
