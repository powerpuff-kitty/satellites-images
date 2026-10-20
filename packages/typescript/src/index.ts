import registry from "./sources.json" with { type: "json" };
import { acquisitionTimestamp } from "./datetime.js";
import { SatelliteError } from "./errors.js";
import { readTextBounded } from "./transport.js";
import { AvailabilityAccumulator } from "./availability.js";
export { SatelliteError } from "./errors.js";

export type BoundingBox = [number, number, number, number];
export type Position = [number, number];
export interface PolygonGeometry { type: "Polygon"; coordinates: Position[][]; }
export interface MultiPolygonGeometry { type: "MultiPolygon"; coordinates: Position[][][]; }
/** GeoJSON polygon area of interest, RFC 7946 `[longitude, latitude]` order. */
export type AoiGeometry = PolygonGeometry | MultiPolygonGeometry;
export type ImageAccess = "open" | "authentication-required" | "payment-required" | "unknown";
export type AcquisitionStatus = "planned" | "predicted";

export interface SearchQuery {
  /** Centre latitude. Required unless `aoi` is supplied. */
  latitude?: number;
  /** Centre longitude. Required unless `aoi` is supplied. */
  longitude?: number;
  /** Search radius in metres (0 < r <= 100000). Required unless `aoi` is supplied. */
  radiusMeters?: number;
  /** Optional GeoJSON Polygon/MultiPolygon. Overrides centre/radius when present. */
  aoi?: AoiGeometry;
  from: string;
  to: string;
  collections?: string[];
  limit?: number;
  maxPages?: number;
  signal?: AbortSignal;
}
export interface SceneAsset {
  key: string;
  href: string;
  type: string | null;
  roles: string[];
  access: ImageAccess;
}
export interface Scene {
  providerId: string;
  id: string;
  collection: string;
  acquiredAt: string;
  mission: string | null;
  geometry: Record<string, unknown> | null;
  bbox: number[] | null;
  cloudCoverPercent: number | null;
  /** Ground sample distance in metres when the provider exposes `gsd` (e.g. 10 for Sentinel-2). */
  gsdMeters: number | null;
  /**
   * Approximate percentage of the requested area of interest whose bounding box
   * overlaps this scene's bounding box (0-100), or null when the scene has no
   * bbox. This is a bbox-overlap heuristic, not a geometric intersection area.
   */
  coveragePercent: number | null;
  previewUrl: string | null;
  access: ImageAccess;
  assets: SceneAsset[];
  sourceUrl: string | null;
  raw: Record<string, unknown>;
}
export interface SearchPage {
  providerId: string;
  items: Scene[];
  pageNumber: number;
  /** More results are advertised or may have been omitted by a bounded result cap. */
  hasNext: boolean;
  matched: number | null;
  /** Count of provider items skipped in this page because they failed normalization. */
  skipped?: number;
}
export interface AcquisitionOpportunity {
  providerId: string;
  mission: string;
  expectedAt: string;
  status: AcquisitionStatus;
  sourceUrl: string;
  footprint?: Record<string, unknown> | null;
  id?: string;
  endAt?: string | null;
  mode?: string | null;
  orbitRelative?: number | null;
}
export interface SourceRecord {
  /** Registry vocabulary: commercial, public or mixed; separate from imagery access. */
  operatorType?: string;
  id: string;
  name: string;
  type: string;
  url: string | null;
  docs: string;
  searchAccess: string;
  imageryAccess: string;
  scheduled: string;
  collections: string[];
  implemented: { typescript: boolean; python: boolean; rust: boolean };
  notes: string;
}

export function listSources(): SourceRecord[] {
  return registry.sources.map((source) => ({ ...source, implemented: { ...source.implemented }, collections: [...source.collections] }));
}

function checkDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) {
    throw new SatelliteError("INVALID_QUERY", label + " must be a valid YYYY-MM-DD date");
  }
}

function validateQuery(query: SearchQuery): number {
  checkDate(query.from, "from");
  checkDate(query.to, "to");
  if (query.from > query.to) throw new SatelliteError("INVALID_QUERY", "from must be <= to");
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new SatelliteError("INVALID_QUERY", "limit must be an integer between 1 and 100");
  }
  const maxPages = query.maxPages ?? 3;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new SatelliteError("INVALID_QUERY", "maxPages must be between 1 and 50");
  }
  return maxPages;
}

function sceneKey(scene: Scene): string {
  return JSON.stringify([scene.collection, scene.id]);
}

function uniqueScenes(scenes: Scene[], seen: Set<string>): Scene[] {
  return scenes.filter(scene => {
    const key = sceneKey(scene);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "number" && typeof value[1] === "number" &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function polygonRings(aoi: AoiGeometry): Position[][] {
  const geometry = aoi as unknown as { type?: unknown; coordinates?: unknown };
  if (!geometry || typeof geometry !== "object" ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    throw new SatelliteError("INVALID_QUERY", "AOI must be a GeoJSON Polygon or MultiPolygon");
  }
  if (!Array.isArray(geometry.coordinates)) {
    throw new SatelliteError("INVALID_QUERY", "AOI geometry has no rings");
  }
  const rings = geometry.type === "Polygon"
    ? geometry.coordinates
    : (geometry.coordinates as unknown[]).flat();
  if (!Array.isArray(rings) || rings.length === 0) {
    throw new SatelliteError("INVALID_QUERY", "AOI geometry has no rings");
  }
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) {
      throw new SatelliteError("INVALID_QUERY", "AOI ring must hold at least 4 ordered [lon,lat] positions");
    }
  }
  return rings;
}

function crossesAntimeridian(rings: Position[][]): boolean {
  return rings.some((ring) => ring.some((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return Math.abs(next[0] - point[0]) > 180;
  }));
}

function latitudeSpan(rings: Position[][]): [number, number] {
  let south = 90, north = -90;
  for (const ring of rings) for (const [, lat] of ring) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [south, north];
}

/**
 * Convert a GeoJSON polygon AOI into one or two STAC-safe bounding boxes.
 * A geometry that crosses the antimeridian is split at +/-180 rather than rejected.
 */
export function polygonBoxes(aoi: AoiGeometry): BoundingBox[] {
  const rings = polygonRings(aoi);
  const [south, north] = latitudeSpan(rings);
  if (!crossesAntimeridian(rings)) {
    let west = 180, east = -180;
    for (const ring of rings) for (const [lon] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
    return [[west, south, east, north]];
  }
  let eastOfLine = 180, westOfLine = -180; // longitudes just east (-) and west (+) of the seam
  for (const ring of rings) for (const [lon] of ring) {
    if (lon > 0 && lon < eastOfLine) eastOfLine = lon;
    if (lon <= 0 && lon > westOfLine) westOfLine = lon;
  }
  const boxes: BoundingBox[] = [];
  if (eastOfLine < 180) boxes.push([Math.max(-180, Math.min(180, eastOfLine)), south, 180, north]);
  if (westOfLine > -180) boxes.push([-180, south, Math.max(-180, Math.min(180, westOfLine)), north]);
  if (!boxes.length) throw new SatelliteError("INVALID_QUERY", "AOI geometry is degenerate");
  return boxes.sort((a, b) => a[0] - b[0]);
}

/**
 * Convert a centre/radius search into one or two STAC-safe bounding boxes.
 * Antimeridian-crossing searches are split; pole-crossing searches use the full
 * longitude range instead of throwing.
 */
export function radiusBoxes(latitude: number, longitude: number, radiusMeters: number): BoundingBox[] {
  if (![latitude, longitude, radiusMeters].every(Number.isFinite) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      radiusMeters <= 0 || radiusMeters > 100000) {
    throw new SatelliteError("INVALID_QUERY", "Invalid coordinates or radius (must be >0 and <=100km)");
  }
  const latDelta = radiusMeters / 110574;
  let south = latitude - latDelta;
  let north = latitude + latDelta;
  const touchesPole = south <= -90 || north >= 90;
  if (south < -90) south = -90;
  if (north > 90) north = 90;
  const cos = Math.cos(latitude * Math.PI / 180);
  if (touchesPole || cos < 0.001) return [[-180, south, 180, north]];
  const lonDelta = radiusMeters / (111320 * cos);
  const west = longitude - lonDelta;
  const east = longitude + lonDelta;
  if (east > 180) return [[west, south, 180, north], [-180, south, east - 360, north]];
  if (west < -180) return [[west + 360, south, 180, north], [-180, south, east, north]];
  return [[west, south, east, north]];
}

/** Backwards-compatible single bounding box; returns the first STAC-safe box. */
export function boundsAround(latitude: number, longitude: number, radiusMeters: number): BoundingBox {
  return radiusBoxes(latitude, longitude, radiusMeters)[0];
}

export interface ResolvedAreas {
  boxes: BoundingBox[];
  /** Present only when a non-splitting polygon AOI can be sent as STAC `intersects`. */
  polygon: AoiGeometry | null;
}

/** Resolve a search query into one or more STAC-safe bounding boxes. */
export function resolveAreas(query: Pick<SearchQuery, "latitude" | "longitude" | "radiusMeters" | "aoi">): ResolvedAreas {
  if (query.aoi) {
    const boxes = polygonBoxes(query.aoi);
    return { boxes, polygon: boxes.length === 1 ? query.aoi : null };
  }
  const { latitude, longitude, radiusMeters } = query;
  if (typeof latitude !== "number" || typeof longitude !== "number" || typeof radiusMeters !== "number") {
    throw new SatelliteError("INVALID_QUERY", "Provide latitude/longitude/radiusMeters or a GeoJSON aoi");
  }
  return { boxes: radiusBoxes(latitude, longitude, radiusMeters), polygon: null };
}

function boxArea(box: BoundingBox): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}
function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return Math.max(0, width) * Math.max(0, height);
}

/** bbox-overlap percentage of a scene within the requested area boxes (0-100). */
export function coveragePercent(sceneBbox: number[] | null, boxes: BoundingBox[]): number | null {
  if (!sceneBbox || sceneBbox.length !== 4 || !sceneBbox.every((v) => Number.isFinite(v))) return null;
  const scene: BoundingBox = [sceneBbox[0], sceneBbox[1], sceneBbox[2], sceneBbox[3]];
  const total = boxes.reduce((sum, box) => sum + boxArea(box), 0);
  if (total <= 0) return null;
  const covered = boxes.reduce((sum, box) => sum + overlapArea(scene, box), 0);
  return Math.max(0, Math.min(100, (covered / total) * 100));
}

function makeBody(query: SearchQuery, defaults: string[], box: BoundingBox, polygon: AoiGeometry | null): Record<string, unknown> {
  validateQuery(query);
  const collections = query.collections ?? defaults;
  if (!collections.length || collections.some((x) => typeof x !== "string" || !x.trim())) {
    throw new SatelliteError("INVALID_QUERY", "Provide at least one collection");
  }
  const body: Record<string, unknown> = {
    datetime: query.from + "T00:00:00Z/" + query.to + "T23:59:59Z",
    collections,
    limit: query.limit ?? 50,
  };
  // STAC allows exactly one spatial filter: bbox OR intersects (sending both is a 400).
  if (polygon) body.intersects = polygon;
  else body.bbox = box;
  return body;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Read a JSON body with a byte ceiling, so a hostile/oversized response cannot exhaust memory. */
async function readJsonBounded(response: Response, providerId: string): Promise<unknown> {
  const text = await readTextBounded(response, MAX_RESPONSE_BYTES, providerId);
  try { return JSON.parse(text); }
  catch { throw new SatelliteError("INVALID_RESPONSE", "Provider response was not valid JSON", providerId); }
}
const MAX_RETRY_DELAY_MS = 60000;
/** Abortable sleep: rejects with ABORTED if the caller's signal fires during backoff. */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SatelliteError("ABORTED", "Request aborted")); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(new SatelliteError("ABORTED", "Request aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
/** Map the registry's coarse `imageryAccess` vocabulary onto the scene-level enum. */
const IMAGERY_ACCESS_CLASS: Readonly<Record<string, ImageAccess>> = {
  "open": "open",
  "account": "authentication-required",
  "paid": "payment-required",
  "paid-or-entitlement": "payment-required",
};
/**
 * Collection-level refinements for sources whose registry entry is deliberately coarse.
 * Each entry mirrors verified provider behaviour rather than an aspiration.
 */
const COLLECTION_ACCESS_OVERRIDES: Readonly<Record<string, ImageAccess>> = {
  // Sentinel-2 L2A assets live in the public `sentinel-cogs` bucket.
  "earth-search:sentinel-2-l2a": "open",
  // Landsat C2 L2 assets are `s3://usgs-landsat/...`: reading them needs an AWS account
  // that accepts requester-pays transfer charges.
  "earth-search:landsat-c2-l2": "authentication-required",
  // Planetary Computer returns anonymous, CORS-enabled SAS URLs for its open-data collections.
  "planetary-computer:sentinel-2-l2a": "open",
  "planetary-computer:landsat-c2-l2": "open",
  "planetary-computer:sentinel-1-rtc": "open",
  "planetary-computer:naip": "open",
};
/** Sub-provider refinements: the provider id already carries the DAAC (e.g. `nasa-cmr:ASF`).
 *  CMR federates many DAACs; only the ASF mirror exposed here is account-gated. */
const PROVIDER_ACCESS_OVERRIDES: Readonly<Record<string, ImageAccess>> = {
  "nasa-cmr:ASF": "authentication-required",
};
/**
 * The access class a provider declares for its image bytes, derived from the shared
 * registry (`sources/registry.json`) plus the refinements above.
 *
 * This is a statement about the published catalogue, **not** a per-asset entitlement
 * check: an individual href can still be expired, signed or gone, so `SceneAsset.access`
 * stays `unknown` until the SDK can verify that specific asset.
 */
export function declaredImageryAccess(providerId: string, collection?: string | null): ImageAccess {
  const key = providerId + ":" + (collection ?? "");
  const override = (Object.hasOwn(COLLECTION_ACCESS_OVERRIDES, key) ? COLLECTION_ACCESS_OVERRIDES[key] : undefined)
    ?? (Object.hasOwn(PROVIDER_ACCESS_OVERRIDES, providerId) ? PROVIDER_ACCESS_OVERRIDES[providerId] : undefined);
  if (override) return override;
  const source = registry.sources.find((entry) => entry.id === providerId.split(":")[0]);
  return (source ? IMAGERY_ACCESS_CLASS[source.imageryAccess] : undefined) ?? "unknown";
}
function normalise(item: unknown, providerId: string, boxes: BoundingBox[]): Scene {
  const raw = object(item);
  const properties = object(raw.properties);
  const id = stringOrNull(raw.id);
  const date = acquisitionTimestamp(properties.datetime ?? properties.start_datetime);
  if (!id || !date) {
    throw new SatelliteError("INVALID_RESPONSE", "STAC item lacks a valid id or acquisition time", providerId);
  }
  const assets = Object.entries(object(raw.assets)).flatMap(([key, value]): SceneAsset[] => {
    const asset = object(value);
    const href = stringOrNull(asset.href);
    if (!href) return [];
    return [{key, href, type: stringOrNull(asset.type), roles: Array.isArray(asset.roles) ? asset.roles.filter((x): x is string => typeof x === "string") : [], access:"unknown"}];
  });
  const preview = assets.find((asset) => asset.roles.includes("thumbnail")) ??
                  assets.find((asset) => ["thumbnail","preview","rendered_preview"].includes(asset.key));
  const cloud = properties["eo:cloud_cover"];
  const cloudCoverPercent = typeof cloud === "number" && Number.isFinite(cloud) && cloud >= 0 && cloud <= 100 ? cloud : null;
  const gsd = properties["gsd"];
  const gsdMeters = typeof gsd === "number" && Number.isFinite(gsd) && gsd > 0 ? gsd : null;
  const originalLinks = Array.isArray(raw.links) ? raw.links : [];
  const link = originalLinks.map(object).find((v) => v.rel === "self");
  // Prefer an http(s) preview: an asset thumbnail (e.g. Sentinel-2 `preview.jpg`), else the
  // item's `thumbnail` link (Earth Search serves this for Landsat, whose asset hrefs are s3://).
  const isHttp = (value: string | null): value is string => Boolean(value && /^https?:\/\//i.test(value));
  const thumbnailLink = originalLinks.map(object).find((v) => v.rel === "thumbnail");
  const thumbnailHref = thumbnailLink ? stringOrNull(thumbnailLink.href) : null;
  const previewUrl = isHttp(preview?.href ?? null) ? preview!.href
    : isHttp(thumbnailHref) ? thumbnailHref
    : preview?.href ?? null;
  const geometry = object(raw.geometry);
  const bbox = Array.isArray(raw.bbox) && raw.bbox.every((v) => typeof v === "number") ? raw.bbox as number[] : null;
  return {
    providerId,
    id,
    collection: stringOrNull(raw.collection) ?? "",
    acquiredAt: date,
    mission: stringOrNull(properties.platform),
    geometry: Object.keys(geometry).length ? geometry : null,
    bbox,
    cloudCoverPercent,
    gsdMeters,
    coveragePercent: coveragePercent(bbox, boxes),
    previewUrl,
    access: declaredImageryAccess(providerId, stringOrNull(raw.collection)),
    assets,
    sourceUrl: link ? stringOrNull(link.href) : null,
    raw,
  };
}

interface NextLink { rel: string; href: string; method?: string; body?: Record<string, unknown>; merge?: boolean }
/** The minimal contract the aggregator requires of any search provider (STAC or bespoke). */
export interface SearchProvider {
  readonly id: string;
  search(query: SearchQuery): AsyncGenerator<SearchPage>;
}
export interface StacProviderOptions {
  id: string;
  baseUrl: string;
  collections: string[];
  fetchImpl?: typeof fetch;
  /** Retry attempts for transient HTTP 429/503 responses. Default 0 (no retries). */
  retries?: number;
  /** Base backoff delay in ms when no `Retry-After` header is present. Default 500. */
  retryBaseDelayMs?: number;
}
export class StacProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly collections: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  constructor(options: StacProviderOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.collections = [...options.collections];
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const retries = options.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      throw new SatelliteError("INVALID_PROVIDER", "retries must be an integer between 0 and 10", this.id);
    }
    this.retries = retries;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 10000) {
      throw new SatelliteError("INVALID_PROVIDER", "retryBaseDelayMs must be between 0 and 10000", this.id);
    }
    this.retryBaseDelayMs = retryBaseDelayMs;
    let url: URL;
    try { url = new URL(this.baseUrl); }
    catch { throw new SatelliteError("INVALID_PROVIDER", "Provider baseUrl is not a valid URL", this.id); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new SatelliteError("INVALID_PROVIDER", "Provider must use HTTPS except localhost", this.id);
    }
  }

  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    const maxPages = validateQuery(query);
    const { boxes, polygon } = resolveAreas(query);
    // One request suffices when filtering by polygon: the geometry already constrains the
    // result, so iterating the split boxes would only repeat it.
    const boxList = polygon ? boxes.slice(0, 1) : boxes;
    const seen = new Set<string>();
    let pageNumber = 0;
    let truncatedEarlier = false;
    for (let boxIndex = 0; boxIndex < boxList.length; boxIndex++) {
      const box = boxList[boxIndex];
      const lastBox = boxIndex === boxList.length - 1;
      let body = makeBody(query, this.collections, box, polygon);
      let href = this.baseUrl + "/search";
      let method = "POST";
      const visited = new Set<string>();
      let boxPages = 0;
      let lastHadNext = false;
      while (boxPages < maxPages) {
        const requestId = JSON.stringify([href,method,body]);
        if (visited.has(requestId)) throw new SatelliteError("PAGINATION_LOOP", "Repeating STAC next link", this.id);
        visited.add(requestId);
        let response: Response;
        try {
          response = await this.fetchImpl(href, {
            method,
            headers: { "Accept": "application/geo+json, application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
            body: method === "POST" ? JSON.stringify(body) : undefined,
            redirect: "error",
            signal: query.signal
              ? AbortSignal.any([query.signal,AbortSignal.timeout(20000)])
              : AbortSignal.timeout(20000),
          });
          for (let attempt = 0; (response.status === 429 || response.status === 503) && attempt < this.retries; attempt++) {
            const retryAfter = Number(response.headers.get("retry-after"));
            const requested = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : this.retryBaseDelayMs * Math.pow(2, attempt);
            const delay = Math.min(requested, MAX_RETRY_DELAY_MS);
            await response.body?.cancel();
            await sleepWithSignal(delay, query.signal);
            response = await this.fetchImpl(href, {
              method,
              headers: { "Accept": "application/geo+json, application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
              body: method === "POST" ? JSON.stringify(body) : undefined,
              redirect: "error",
              signal: query.signal
                ? AbortSignal.any([query.signal,AbortSignal.timeout(20000)])
                : AbortSignal.timeout(20000),
            });
          }
        } catch (error) {
          if (error instanceof SatelliteError) throw error;
          if ((error as { name?: string })?.name === "AbortError") {
            throw new SatelliteError("ABORTED", "STAC request aborted", this.id);
          }
          throw new SatelliteError("NETWORK", "STAC request failed: " + String(error), this.id);
        }
        if (!response.ok) throw new SatelliteError("HTTP_ERROR", "STAC API returned HTTP " + response.status, this.id);
        let data: unknown;
        try { data = await readJsonBounded(response, this.id); }
        catch (error) { if (error instanceof SatelliteError) throw error; throw new SatelliteError("INVALID_RESPONSE", "STAC response was not valid JSON", this.id); }
        const page = object(data);
        if (!Array.isArray(page.features)) throw new SatelliteError("INVALID_RESPONSE", "STAC response lacks a features array", this.id);
        if (page.features.length > 10000) throw new SatelliteError("INVALID_RESPONSE", "STAC page exceeds the 10000-feature limit", this.id);
        const links = (Array.isArray(page.links) ? page.links : []).map(object);
        const next = links.find((link) => link.rel === "next") as unknown as NextLink | undefined;
        const matched = object(page.context).matched ?? object(page.numberMatched).value;
        const scenes: Scene[] = [];
        let skipped = 0;
        for (const feature of page.features) {
          let scene: Scene;
          try { scene = normalise(feature, this.id, boxes); }
          catch { skipped += 1; continue; }
          const key = sceneKey(scene);
          if (seen.has(key)) continue;
          seen.add(key);
          scenes.push(scene);
        }
        boxPages += 1;
        pageNumber += 1;
        lastHadNext = Boolean(next);
        yield { providerId:this.id, items:scenes, pageNumber, hasNext:Boolean(next) || (lastBox && truncatedEarlier), matched: typeof matched === "number" ? matched : (typeof page.numberMatched === "number" ? page.numberMatched : null), skipped };
        if (!next) break;
        if (typeof next.href !== "string") throw new SatelliteError("INVALID_RESPONSE", "STAC next link has no URL", this.id);
        const resolved = new URL(next.href, href);
        const allowed = new URL(this.baseUrl);
        if (resolved.origin !== allowed.origin || (allowed.protocol === "https:" && resolved.protocol !== "https:")) {
          throw new SatelliteError("UNSAFE_NEXT_LINK", "STAC pagination cannot follow a different origin", this.id);
        }
        const nextMethod = (next.method ?? "GET").toUpperCase();
        if (nextMethod !== "GET" && nextMethod !== "POST") throw new SatelliteError("INVALID_RESPONSE", "Unsupported STAC pagination method", this.id);
        method = nextMethod;
        href = resolved.toString();
        if (method === "POST") {
          const nextBody = object(next.body);
          // STAC pagination: `merge` defaults to false, so the next body replaces the query.
          body = next.merge === true ? { ...body, ...nextBody } : nextBody;
        }
      }
      if (boxPages >= maxPages && lastHadNext) truncatedEarlier = true;
    }
  }
}

export function earthSearch(fetchImpl?: typeof fetch): StacProvider {
  return new StacProvider({
    id:"earth-search", baseUrl:"https://earth-search.aws.element84.com/v1",
    collections:["sentinel-2-l2a","landsat-c2-l2"], fetchImpl,
  });
}
export function planetaryComputer(fetchImpl?: typeof fetch): StacProvider {
  return new StacProvider({
    id:"planetary-computer", baseUrl:"https://planetarycomputer.microsoft.com/api/stac/v1",
    collections:["sentinel-2-l2a","landsat-c2-l2","sentinel-1-rtc","naip"], fetchImpl,
  });
}
/** INPE's Brazil-focused CBERS-4A 2 m fused visual collection (CC BY 4.0).
 * Items may omit platform/gsd and provide day-level timestamps; preserve those unknowns.
 */
export function inpeCbers(fetchImpl?: typeof fetch): StacProvider {
  return new StacProvider({
    id:"inpe-cbers", baseUrl:"https://data.inpe.br/bdc/stac/v1",
    collections:["CB4A-WPM-PCA-FUSED-1"], fetchImpl,
  });
}
/** Copernicus Data Space Ecosystem STAC (anonymous metadata; assets are account-gated). */
export function copernicusDataSpace(fetchImpl?: typeof fetch): StacProvider {
  return new StacProvider({
    id:"copernicus", baseUrl:"https://stac.dataspace.copernicus.eu/v1",
    collections:["sentinel-2-l2a","sentinel-1-grd"], fetchImpl,
  });
}
/** USGS LandsatLook STAC server. Server-side use only: its CORS policy blocks other browser origins. */
export function usgsLandsatLook(fetchImpl?: typeof fetch): StacProvider {
  return new StacProvider({
    id:"usgs-landsatlook", baseUrl:"https://landsatlook.usgs.gov/stac-server",
    collections:["landsat-c2l2-sr","landsat-c2l2-st","landsat-c2l1"], fetchImpl,
  });
}
/** NASA CMR-STAC, provider-scoped (e.g. "ASF", "USGS_LTA", "JAXA", "EUMETSAT"). */
export function cmrStac(providerId: string, collections: string[], fetchImpl?: typeof fetch): StacProvider {
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
    throw new SatelliteError("INVALID_PROVIDER", "CMR provider id must be alphanumeric");
  }
  return new StacProvider({
    id:"nasa-cmr:"+providerId, baseUrl:`https://cmr.earthdata.nasa.gov/stac/${providerId}`,
    collections, fetchImpl,
  });
}

export const ASF_SEARCH_ENDPOINT = "https://api.daac.asf.alaska.edu/services/search/param";

/** Map one ASF Search API GeoJSON feature to a normalized scene. */
export function normalizeAsfFeature(item: unknown, providerId = "asf-vertex"): Scene {
  const raw = object(item);
  const properties = object(raw.properties);
  const id = stringOrNull(properties.granuleName) ?? stringOrNull(properties.sceneName) ?? stringOrNull(raw.id);
  const date = acquisitionTimestamp(properties.startTime ?? properties.stopTime);
  if (!id || !date) {
    throw new SatelliteError("INVALID_RESPONSE", "ASF feature lacks a valid granule name or start time", providerId);
  }
  const browse = Array.isArray(properties.browse) ? properties.browse.filter((x): x is string => typeof x === "string") : [];
  const download = stringOrNull(properties.downloadUrl);
  const assets: SceneAsset[] = [];
  if (download) assets.push({ key:"data", href:download, type:null, roles:["data"], access:"unknown" });
  browse.forEach((href, index) => assets.push({ key:"browse_"+index, href, type:null, roles:["thumbnail"], access:"unknown" }));
  const geometry = object(raw.geometry);
  return {
    providerId,
    id,
    collection: stringOrNull(properties.processingLevel) ?? "asf",
    acquiredAt: date,
    mission: stringOrNull(properties.platform),
    geometry: Object.keys(geometry).length ? geometry : null,
    bbox: null,
    cloudCoverPercent: null,
    gsdMeters: null,
    coveragePercent: null,
    previewUrl: browse[0] ?? null,
    access: declaredImageryAccess(providerId),
    assets,
    sourceUrl: download,
    raw,
  };
}

function asfFeatures(data: unknown): unknown[] {
  const obj = object(data);
  if (Array.isArray(obj.features)) return obj.features;
  return Object.values(obj).flatMap((value) => Array.isArray(value) ? asfFeatures(value) : []);
}

export interface AsfProviderOptions { platforms?: string[]; fetchImpl?: typeof fetch }
/**
 * Alaska Satellite Facility (ASF) Search API adapter.
 *
 * The SAR catalogue is keyword-based (not STAC); results are requested as GeoJSON.
 * Metadata search is anonymous; downloading products needs Earthdata authentication.
 */
export class AsfProvider {
  readonly id = "asf-vertex";
  private readonly platforms: string[];
  private readonly fetchImpl: typeof fetch;
  constructor(options: AsfProviderOptions = {}) {
    this.platforms = options.platforms ?? ["SENTINEL-1"];
    if (!this.platforms.length || this.platforms.some((p) => !/^[A-Za-z0-9-]+$/.test(p))) {
      throw new SatelliteError("INVALID_PROVIDER", "ASF platform must be alphanumeric", this.id);
    }
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    validateQuery(query);
    const { boxes } = resolveAreas(query);
    const seen = new Set<string>();
    let pageNumber = 0;
    let truncated = false;
    for (const box of boxes) {
      const params = new URLSearchParams({
        platform: this.platforms.join(","),
        start: query.from,
        end: query.to,
        bbox: box.map((value) => value.toFixed(6)).join(","),
        maxResults: String(query.limit ?? 50),
        output: "geojson",
      });
      let response: Response;
      try {
        response = await this.fetchImpl(ASF_SEARCH_ENDPOINT + "?" + params.toString(), {
          headers: { "Accept": "application/geo+json, application/json" },
          redirect: "error",
          signal: query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        });
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") throw new SatelliteError("ABORTED", "ASF request aborted", this.id);
        throw new SatelliteError("NETWORK", "ASF request failed: " + String(error), this.id);
      }
      if (!response.ok) throw new SatelliteError("HTTP_ERROR", "ASF returned HTTP " + response.status, this.id);
      const data = await readJsonBounded(response, this.id);
      const features = asfFeatures(data);
      if (features.length > 10000) throw new SatelliteError("INVALID_RESPONSE", "ASF page exceeds the 10000-feature limit", this.id);
      const scenes = uniqueScenes(features.map((feature) => normalizeAsfFeature(feature, this.id)), seen);
      pageNumber += 1;
      // maxResults is a cap, not an estimate of the complete catalogue count.
      truncated ||= features.length >= (query.limit ?? 50);
      yield { providerId:this.id, items:scenes, pageNumber,
        hasNext:truncated, matched:null };
    }
  }
}
export function asfSearch(options: AsfProviderOptions = {}): AsfProvider {
  return new AsfProvider(options);
}

export const JAXA_CSW_ENDPOINT = "https://gportal.jaxa.jp/csw/csw";

/** Map one JAXA G-Portal CSW granule (GeoJSON output) to a normalized scene. */
export function normalizeJaxaFeature(item: unknown, providerId = "jaxa-gportal"): Scene {
  const raw = object(item);
  const properties = object(raw.properties);
  const gpp = object(properties.gpp);
  const id = stringOrNull(properties.identifier);
  // beginPosition is the real observation start, distinct from processingDate (indexing date).
  const date = acquisitionTimestamp(properties.beginPosition ?? properties.endPosition);
  if (!id || !date) {
    throw new SatelliteError("INVALID_RESPONSE", "JAXA feature lacks an identifier or begin position", providerId);
  }
  const browse = Array.isArray(properties.browse)
    ? properties.browse.map(object).filter((b) => typeof b.fileName === "string") : [];
  const product = object(properties.product);
  const download = stringOrNull(product.fileName);
  const assets: SceneAsset[] = [];
  if (download) assets.push({ key:"data", href:download, type:stringOrNull(product.DataFormatType), roles:["data"], access:"unknown" });
  browse.forEach((b, index) => assets.push({ key:"browse_"+index, href:String(b.fileName), type:null, roles:["thumbnail"], access:"unknown" }));
  const geometry = object(raw.geometry);
  const cloudText = stringOrNull(gpp.cloudCoverPercentage);
  const cloud = cloudText !== null && Number.isFinite(Number(cloudText)) ? Number(cloudText) : null;
  return {
    providerId, id,
    collection: stringOrNull(properties.platformShortName) ?? "jaxa",
    acquiredAt: date,
    mission: stringOrNull(properties.platformShortName),
    geometry: Object.keys(geometry).length ? geometry : null,
    bbox: null,
    cloudCoverPercent: cloud !== null && cloud >= 0 && cloud <= 100 ? cloud : null,
    gsdMeters: null,
    coveragePercent: null,
    previewUrl: browse.length ? String(browse[0].fileName) : null,
    access: declaredImageryAccess(providerId),
    assets,
    sourceUrl: download,
    raw,
  };
}

export interface JaxaProviderOptions {
  /** Numeric JAXA G-Portal dataset id (e.g. "10002002"); short names are rejected by the service. */
  datasetId: string;
  /** Optional resolution partition, e.g. "250m" or "1km". */
  resolution?: string;
  count?: number;
  fetchImpl?: typeof fetch;
}
/**
 * JAXA G-Portal granule adapter (CSW 3.0.0 GET returning GeoJSON).
 *
 * Metadata search is anonymous. Only GET is supported (POST is WAF-blocked).
 * The `bbox` is sent as west,south,east,north per the reference; confirm axis
 * order against the live service before relying on spatial filtering.
 */
export class JaxaProvider {
  readonly id = "jaxa-gportal";
  private readonly datasetId: string;
  private readonly resolution?: string;
  private readonly count: number;
  private readonly fetchImpl: typeof fetch;
  constructor(options: JaxaProviderOptions) {
    if (!/^\d+$/.test(options.datasetId)) {
      throw new SatelliteError("INVALID_PROVIDER", "A numeric JAXA datasetId is required", this.id);
    }
    this.datasetId = options.datasetId;
    this.resolution = options.resolution;
    const count = options.count ?? 100;
    if (!Number.isInteger(count) || count < 1 || count > 3000) {
      throw new SatelliteError("INVALID_PROVIDER", "count must be an integer between 1 and 3000", this.id);
    }
    this.count = count;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    validateQuery(query);
    const { boxes } = resolveAreas(query);
    const seen = new Set<string>();
    let pageNumber = 0;
    let truncated = false;
    for (const box of boxes) {
      const params = new URLSearchParams({
        service: "CSW", version: "3.0.0", request: "GetRecords", outputFormat: "application/json",
        datasetId: this.datasetId,
        startTime: query.from + "T00:00:00Z", endTime: query.to + "T23:59:59Z",
        bbox: box.map((value) => value.toFixed(6)).join(","), count: String(this.count), startIndex: "1",
      });
      if (this.resolution) params.set("resolution", this.resolution);
      let response: Response;
      try {
        response = await this.fetchImpl(JAXA_CSW_ENDPOINT + "?" + params.toString(), {
          headers: { "Accept": "application/json" },
          redirect: "error",
          signal: query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
        });
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") throw new SatelliteError("ABORTED", "JAXA request aborted", this.id);
        throw new SatelliteError("NETWORK", "JAXA request failed: " + String(error), this.id);
      }
      if (!response.ok) throw new SatelliteError("HTTP_ERROR", "JAXA returned HTTP " + response.status, this.id);
      const data = await readJsonBounded(response, this.id);
      const page = object(data);
      if (!Array.isArray(page.features)) throw new SatelliteError("INVALID_RESPONSE", "JAXA response lacks a features array", this.id);
      if (page.features.length > 10000) throw new SatelliteError("INVALID_RESPONSE", "JAXA page exceeds the 10000-feature limit", this.id);
      const scenes = uniqueScenes(page.features.map((feature) => normalizeJaxaFeature(feature, this.id)), seen);
      pageNumber += 1;
      const matched = object(page.properties).numberOfRecordsMatched;
      const total = typeof matched === "number" && Number.isInteger(matched) && matched >= 0 ? matched : null;
      truncated ||= total === null ? page.features.length >= this.count : total > page.features.length;
      yield { providerId:this.id, items:scenes, pageNumber,
        hasNext:truncated,
        matched:total };
    }
  }
}
export function jaxaGPortal(options: JaxaProviderOptions): JaxaProvider {
  return new JaxaProvider(options);
}

export const OPEN_AERIAL_MAP_ENDPOINT = "https://api.openaerialmap.org/meta";

function numericBbox(value: unknown): number[] | null {
  return Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value as number[] : null;
}
/** A GeoJSON Polygon/MultiPolygon from a record, or null when the shape is unusable. */
function geoJsonGeometry(value: unknown): Record<string, unknown> | null {
  const geometry = object(value);
  const type = stringOrNull(geometry.type);
  return (type === "Polygon" || type === "MultiPolygon") && Array.isArray(geometry.coordinates) ? geometry : null;
}
/**
 * Map one OpenAerialMap record to a normalized scene.
 *
 * These are drone/aircraft images rather than satellite scenes: there is no cloud metadata, and
 * the provider reports `gsd` in **degrees** at scales that disagree between records (observed
 * 1.9e-7 and 2.8e-3 for comparable UAV captures), so it is kept in `raw` instead of being
 * guessed into metres. Per-image licences vary — the API itself is CC-BY 4.0 — so the declared
 * access class stays `unknown`.
 */
export function normalizeOamRecord(record: unknown, providerId = "open-aerial-map", boxes: BoundingBox[] = []): Scene {
  const raw = object(record);
  const id = stringOrNull(raw["_id"]);
  const date = acquisitionTimestamp(raw.acquisition_start ?? raw.acquisition_end);
  if (!id || !date) {
    throw new SatelliteError("INVALID_RESPONSE", "OpenAerialMap record lacks an id or acquisition time", providerId);
  }
  const assets: SceneAsset[] = [];
  const tilejson = stringOrNull(object(raw.properties).tilejson);
  if (tilejson) assets.push({ key:"tilejson", href:tilejson, type:"application/json", roles:["tiles"], access:"unknown" });
  const source = stringOrNull(raw.uuid);
  if (source) assets.push({ key:"data", href:source, type:null, roles:["data"], access:"unknown" });
  const bbox = numericBbox(raw.bbox);
  // The provider's own `geojson` when present, else the bbox as a rectangle (the WKT
  // `footprint` is retained in `raw`).
  const geometry = geoJsonGeometry(raw.geojson) ?? (bbox ? {
    type:"Polygon",
    coordinates:[[[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[2],bbox[1]],[bbox[0],bbox[1]],[bbox[0],bbox[3]]]],
  } : null);
  return {
    providerId,
    id,
    collection: "openaerialmap",
    acquiredAt: date,
    mission: stringOrNull(raw.platform) ?? "openaerialmap",
    geometry,
    bbox,
    cloudCoverPercent: null,
    gsdMeters: null,
    coveragePercent: coveragePercent(bbox, boxes),
    previewUrl: null,
    access: declaredImageryAccess(providerId),
    assets,
    sourceUrl: stringOrNull(raw.meta_uri),
    raw,
  };
}

export interface OamProviderOptions { limit?: number; fetchImpl?: typeof fetch }
/**
 * OpenAerialMap metadata adapter.
 *
 * Crowdsourced aerial imagery (drone/aircraft, not satellite) over an anonymous API:
 * `GET api.openaerialmap.org/meta?bbox=&acquisition_from=&acquisition_to=&limit=&page=`.
 * The acquisition window is filtered server-side and mapped from the query's `from`/`to`;
 * `meta.found` is the provider's total for that filter, and `hasNext` is derived from it.
 * No preview thumbnail is published — each record instead carries a `tilejson` asset, which the
 * explorer can render on the map at native resolution.
 */
export class OamProvider {
  readonly id = "open-aerial-map";
  private readonly limit: number;
  private readonly fetchImpl: typeof fetch;
  constructor(options: OamProviderOptions = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SatelliteError("INVALID_PROVIDER", "OpenAerialMap limit must be an integer between 1 and 100", this.id);
    }
    this.limit = limit;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    const maxPages = validateQuery(query);
    const { boxes } = resolveAreas(query);
    const limit = Math.min(this.limit, query.limit ?? this.limit);
    const seen = new Set<string>();
    let pageNumber = 0;
    let truncatedEarlier = false;
    for (const [boxIndex, box] of boxes.entries()) {
      for (let page = 1; page <= maxPages; page += 1) {
        const params = new URLSearchParams({
          bbox: box.map((value) => value.toFixed(6)).join(","),
          acquisition_from: query.from,
          acquisition_to: query.to,
          limit: String(limit),
          page: String(page),
        });
        let response: Response;
        try {
          response = await this.fetchImpl(OPEN_AERIAL_MAP_ENDPOINT + "?" + params.toString(), {
            headers: { "Accept": "application/json" },
            redirect: "error",
            signal: query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
          });
        } catch (error) {
          if ((error as { name?: string })?.name === "AbortError") throw new SatelliteError("ABORTED", "OpenAerialMap request aborted", this.id);
          throw new SatelliteError("NETWORK", "OpenAerialMap request failed: " + String(error), this.id);
        }
        if (!response.ok) throw new SatelliteError("HTTP_ERROR", "OpenAerialMap returned HTTP " + response.status, this.id);
        const data = object(await readJsonBounded(response, this.id));
        if (!Array.isArray(data.results)) throw new SatelliteError("INVALID_RESPONSE", "OpenAerialMap response lacks a results array", this.id);
        const results = data.results;
        if (results.length > 10000) throw new SatelliteError("INVALID_RESPONSE", "OpenAerialMap page exceeds the 10000-record limit", this.id);
        const scenes = uniqueScenes(results.map((record) => normalizeOamRecord(record, this.id, boxes)), seen);
        const found = object(data.meta).found;
        const matched = typeof found === "number" && Number.isInteger(found) && found >= 0 ? found : null;
        pageNumber += 1;
        const hasNext = results.length === limit && (matched === null || page * limit < matched);
        yield { providerId:this.id, items:scenes, pageNumber,
          hasNext:hasNext || (boxIndex === boxes.length - 1 && truncatedEarlier), matched };
        if (!hasNext) break;
        if (page === maxPages) truncatedEarlier = true;
      }
    }
  }
}
export function openAerialMap(options: OamProviderOptions = {}): OamProvider {
  return new OamProvider(options);
}

export interface AcquisitionProvider {
  readonly id: string;
  upcoming(query: import("./acquisitions.js").AcquisitionQuery): Promise<AcquisitionOpportunity[]>;
}
export { AvailabilityAccumulator, summarizeAvailability } from "./availability.js";
export type { AvailabilitySummary, AvailabilityMonth, AvailabilityDay, ProviderAvailability } from "./availability.js";
export { ESAPlansProvider, esaSentinelPlans, parseESAPlanIndex, parseESAPlanKml } from "./acquisitions.js";
export type { ESAPlan, ESAPlansOptions, AcquisitionQuery, ESAPlanDiagnostic, ESAUpcomingResult } from "./acquisitions.js";

export class SatelliteCatalog {
  constructor(private readonly providers: SearchProvider[],
    private readonly acquisitionProviders: AcquisitionProvider[] = []) {
    if (!providers.length) throw new SatelliteError("INVALID_PROVIDER", "Add at least one implemented provider");
    const ids = new Set(providers.map((p) => p.id));
    if (ids.size !== providers.length) throw new SatelliteError("INVALID_PROVIDER", "Duplicate provider ids");
  }
  listSources(): SourceRecord[] { return listSources(); }
  async *search(query: SearchQuery, providerIds?: string[]): AsyncGenerator<SearchPage> {
    const wanted = providerIds ? new Set(providerIds) : null;
    if (wanted) {
      for (const id of wanted) {
        if (!this.providers.some((provider) => provider.id === id)) {
          throw new SatelliteError("UNSUPPORTED_PROVIDER", "Provider not configured: " + id);
        }
      }
    }
    for (const provider of this.providers) {
      if (wanted && !wanted.has(provider.id)) continue;
      yield* provider.search(query);
    }
  }
  async availability(query: SearchQuery, providerIds?: string[]): Promise<import("./availability.js").AvailabilitySummary> {
    validateQuery(query);
    resolveAreas(query);
    if (providerIds?.some(id => !this.providers.some(provider => provider.id === id))) {
      throw new SatelliteError("UNSUPPORTED_PROVIDER", "Requested provider not configured");
    }
    const accumulator=new AvailabilityAccumulator();
    for (const provider of this.providers) {
      if (providerIds && !providerIds.includes(provider.id)) continue;
      accumulator.expectProvider(provider.id);
      try {
        for await (const page of provider.search(query)) accumulator.addPage(page);
      } catch (error) {
        if (error instanceof SatelliteError && error.code === "INVALID_QUERY") throw error;
        accumulator.markError(provider.id);
      }
    }
    return accumulator.summary();
  }
  async upcoming(query: import("./acquisitions.js").AcquisitionQuery,
    providerIds?: string[]): Promise<AcquisitionOpportunity[]> {
    if (!this.acquisitionProviders.length) throw new SatelliteError("UNSUPPORTED",
      "Configure an acquisition provider such as esaSentinelPlans()");
    const selected = providerIds ? new Set(providerIds) : null;
    if (selected && [...selected].some(id => !this.acquisitionProviders.some(p => p.id === id)))
      throw new SatelliteError("UNSUPPORTED_PROVIDER", "Acquisition provider not configured");
    const results:AcquisitionOpportunity[]=[];
    for (const provider of this.acquisitionProviders) {
      if (selected && !selected.has(provider.id)) continue;
      results.push(...await provider.upcoming(query));
    }
    return results.sort((a,b) => a.expectedAt.localeCompare(b.expectedAt));
  }
}

export interface MaxarOpenDataOptions {
  /** Static STAC root; override for a mirror or fixture. */
  catalogUrl?: string;
  fetchImpl?: typeof fetch;
  /** Total metadata documents per search, 1..10000. Default 2000. */
  maxDocuments?: number;
}
const MAXAR_CATALOG = "https://maxar-opendata.s3.amazonaws.com/events/catalog.json";
function maxarTimestamp(value: unknown): string | null {
  return typeof value === "string" ? acquisitionTimestamp(value.replace(" ", "T")) : null;
}
function maxarBoxes(value: unknown): BoundingBox[] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === "number" && Number.isFinite(v))) return [];
  const [w,s,e,n] = value as BoundingBox;
  if (w < -180 || w > 180 || e < -180 || e > 180 || s < -90 || n > 90 || s > n) return [];
  return w <= e ? [[w,s,e,n]] : [[w,s,180,n],[-180,s,e,n]];
}
function maxarOverlaps(value: unknown, boxes: BoundingBox[]): boolean {
  return maxarBoxes(value).some(a => boxes.some(b => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]));
}
/** Bounded discovery of Maxar's selected public releases; never fetches imagery. */
export class MaxarOpenDataProvider implements SearchProvider {
  readonly id = "maxar-open-data";
  private readonly root: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly maxDocuments: number;
  constructor(options: MaxarOpenDataOptions = {}) {
    try { this.root = new URL(options.catalogUrl ?? MAXAR_CATALOG); }
    catch { throw new SatelliteError("INVALID_PROVIDER", "Invalid Maxar catalogue URL", this.id); }
    if ((this.root.protocol !== "https:" && !(this.root.protocol === "http:" && ["localhost","127.0.0.1"].includes(this.root.hostname))) ||
        this.root.username || this.root.password || this.root.search || this.root.hash)
      throw new SatelliteError("INVALID_PROVIDER", "Maxar catalogue must use HTTPS without credentials/query/fragment", this.id);
    this.fetchImpl = options.fetchImpl ?? ((input,init) => fetch(input,init));
    this.maxDocuments = options.maxDocuments ?? 2000;
    if (!Number.isInteger(this.maxDocuments) || this.maxDocuments < 1 || this.maxDocuments > 10000)
      throw new SatelliteError("INVALID_PROVIDER", "maxDocuments must be 1..10000", this.id);
  }
  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    const maxPages = validateQuery(query), { boxes } = resolveAreas(query);
    const limit = query.limit ?? 50;
    const from = query.from + "T00:00:00.000Z", until = query.to + "T23:59:59.999Z";
    const directory = new URL(".", this.root).pathname;
    type Node = { href: string; release: string | null; license: string | null };
    const pending: Node[] = [{ href: this.root.href, release: null, license: null }];
    const scheduled = new Set([this.root.href]), seen = new Set<string>();
    let documents = 0, pageDocuments = 0, pageNumber = 0, skipped = 0;
    let items: Scene[] = [];
    while (pending.length && documents < this.maxDocuments && pageNumber < maxPages) {
      if (query.signal?.aborted) throw new SatelliteError("ABORTED", "Maxar search aborted", this.id);
      const node = pending.pop()!;
      const signal = query.signal ? AbortSignal.any([query.signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
      let response: Response;
      try { response = await this.fetchImpl(node.href, { method:"GET", headers:{Accept:"application/json"}, redirect:"error", credentials:"omit", signal }); }
      catch (error) { throw new SatelliteError(signal.aborted ? "ABORTED" : "NETWORK", "Maxar metadata request failed: " + String(error), this.id); }
      if (!response.ok) { await response.body?.cancel(); throw new SatelliteError("HTTP_ERROR", "Maxar catalogue returned HTTP " + response.status, this.id); }
      const data = object(await readJsonBounded(response,this.id));
      documents++; pageDocuments++;
      const type = data.type;
      if (!["Catalog","Collection","Feature"].includes(String(type)))
        throw new SatelliteError("INVALID_RESPONSE", "Unsupported static STAC document", this.id);
      const release = node.release ?? (type === "Collection" ? stringOrNull(data.id) : null);
      const license = stringOrNull(data.license) ?? node.license;
      let include = true;
      if (type === "Collection") {
        const extent = object(data.extent);
        const bounds = object(extent.spatial).bbox;
        if (Array.isArray(bounds) && bounds.length && bounds.every(box => maxarBoxes(box).length))
          include = bounds.some(box => maxarOverlaps(box,boxes));
        const intervals = object(extent.temporal).interval;
        if (include && Array.isArray(intervals) && intervals.length && intervals.every(interval => Array.isArray(interval) && interval.length === 2 &&
            interval.every(value => value === null || maxarTimestamp(value))))
          include = intervals.some(interval => (!interval[0] || maxarTimestamp(interval[0])! <= until) && (!interval[1] || maxarTimestamp(interval[1])! >= from));
        if (include && !node.release && query.collections?.length && !query.collections.includes(this.id) && !query.collections.includes(release ?? "")) include = false;
      }
      if (type === "Feature") {
        const at = maxarTimestamp(object(data.properties).datetime);
        if (!at || !stringOrNull(data.id) || !maxarBoxes(data.bbox).length) skipped++;
        else if (at >= from && at <= until && maxarOverlaps(data.bbox,boxes)) {
          const prepared = { ...data, collection: stringOrNull(data.collection) ?? release ?? this.id,
            properties:{ ...object(data.properties),datetime:at, ...(license ? {license} : {}) },
            assets:Object.fromEntries(Object.entries(object(data.assets)).map(([key,value]) => {
              const asset = object(value);
              return [key,{ ...asset,href:typeof asset.href === "string" ? new URL(asset.href,node.href).href : asset.href }];
            })),
            links:[{rel:"self",href:node.href}, ...(license === "CC-BY-NC-4.0" ? [{rel:"license",href:"https://creativecommons.org/licenses/by-nc/4.0/"}] : []),
              ...(Array.isArray(data.links) ? data.links.map(link => { const record=object(link); return {...record,href:typeof record.href === "string" ? new URL(record.href,node.href).href : record.href}; }) : [])],
          };
          const scene = { ...normalise(prepared,this.id,boxes),raw:data };
          const key = sceneKey(scene);
          if (!seen.has(key)) { seen.add(key); items.push(scene); }
        }
      } else if (include) {
        if (!Array.isArray(data.links) || data.links.length > 10000) throw new SatelliteError("INVALID_RESPONSE", "Invalid static catalogue links", this.id);
        const children = data.links.map(object).filter(link => link.rel === "child" || link.rel === "item");
        const queued: Node[] = [];
        for (const link of children) {
          if (typeof link.href !== "string") throw new SatelliteError("INVALID_RESPONSE", "Static catalogue link lacks a URL", this.id);
          const href = new URL(link.href,node.href);
          if (href.origin !== this.root.origin || !href.pathname.startsWith(directory) || href.username || href.password || href.search || href.hash)
            throw new SatelliteError("UNSAFE_NEXT_LINK", "Static catalogue cannot leave its root directory/origin", this.id);
          if (!scheduled.has(href.href)) { scheduled.add(href.href); queued.push({href:href.href,release,license}); }
          if (scheduled.size > 100000) throw new SatelliteError("INVALID_RESPONSE", "Static catalogue has too many links", this.id);
        }
        pending.push(...queued.reverse());
      }
      if (items.length >= limit || pageDocuments >= 100 || !pending.length || documents === this.maxDocuments) {
        pageNumber++;
        yield {providerId:this.id,items,pageNumber,hasNext:pending.length > 0,matched:null,skipped};
        items=[]; skipped=0; pageDocuments=0;
      }
    }
  }
}
export function maxarOpenData(options: MaxarOpenDataOptions = {}): MaxarOpenDataProvider {
  return new MaxarOpenDataProvider(options);
}
