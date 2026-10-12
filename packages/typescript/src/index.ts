import registry from "./sources.json" with { type: "json" };

export type BoundingBox = [number, number, number, number];
export type ImageAccess = "open" | "authentication-required" | "payment-required" | "unknown";
export type AcquisitionStatus = "planned" | "predicted";

export interface SearchQuery {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  from: string;
  to: string;
  collections?: string[];
  limit?: number;
  maxPages?: number;
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
  hasNext: boolean;
  matched: number | null;
}
export interface AcquisitionOpportunity {
  providerId: string;
  mission: string;
  expectedAt: string;
  status: AcquisitionStatus;
  sourceUrl: string;
  footprint?: Record<string, unknown> | null;
}
export interface SourceRecord {
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

export class SatelliteError extends Error {
  constructor(public readonly code: string, message: string, public readonly providerId?: string) {
    super(message);
    this.name = "SatelliteError";
  }
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

export function boundsAround(latitude: number, longitude: number, radiusMeters: number): BoundingBox {
  if (![latitude, longitude, radiusMeters].every(Number.isFinite) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      radiusMeters <= 0 || radiusMeters > 100000) {
    throw new SatelliteError("INVALID_QUERY", "Invalid coordinates or radius (must be >0 and <=100km)");
  }
  const latDelta = radiusMeters / 110574;
  const north = latitude + latDelta;
  const south = latitude - latDelta;
  if (south < -90 || north > 90) {
    throw new SatelliteError("UNSUPPORTED_AREA", "AOI crosses a pole; geographic bbox not supported");
  }
  const cos = Math.cos(latitude * Math.PI / 180);
  if (cos < 0.001) throw new SatelliteError("UNSUPPORTED_AREA", "AOI too close to a pole");
  const lonDelta = radiusMeters / (111320 * cos);
  if (longitude - lonDelta < -180 || longitude + lonDelta > 180) {
    throw new SatelliteError("UNSUPPORTED_AREA", "AOI crosses the antimeridian; use a different AOI");
  }
  return [longitude - lonDelta, south, longitude + lonDelta, north];
}

function makeBody(query: SearchQuery, defaults: string[]): Record<string, unknown> {
  checkDate(query.from, "from");
  checkDate(query.to, "to");
  if (query.from > query.to) throw new SatelliteError("INVALID_QUERY", "from must be <= to");
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new SatelliteError("INVALID_QUERY", "limit must be an integer between 1 and 100");
  }
  const collections = query.collections ?? defaults;
  if (!collections.length || collections.some((x) => typeof x !== "string" || !x.trim())) {
    throw new SatelliteError("INVALID_QUERY", "Provide at least one collection");
  }
  return {
    bbox: boundsAround(query.latitude, query.longitude, query.radiusMeters),
    datetime: query.from + "T00:00:00Z/" + query.to + "T23:59:59Z",
    collections,
    limit: query.limit ?? 50,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}
function normalise(item: unknown, providerId: string): Scene {
  const raw = object(item);
  const properties = object(raw.properties);
  const id = stringOrNull(raw.id);
  const date = stringOrNull(properties.datetime) ?? stringOrNull(properties.start_datetime);
  if (!id || !date || Number.isNaN(Date.parse(date))) {
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
  const originalLinks = Array.isArray(raw.links) ? raw.links : [];
  const link = originalLinks.map(object).find((v) => v.rel === "self");
  const geometry = object(raw.geometry);
  return {
    providerId,
    id,
    collection: stringOrNull(raw.collection) ?? "",
    acquiredAt: new Date(date).toISOString(),
    mission: stringOrNull(properties.platform),
    geometry: Object.keys(geometry).length ? geometry : null,
    bbox: Array.isArray(raw.bbox) && raw.bbox.every((v) => typeof v === "number") ? raw.bbox as number[] : null,
    cloudCoverPercent,
    previewUrl: preview?.href ?? null,
    access: "unknown",
    assets,
    sourceUrl: link ? stringOrNull(link.href) : null,
    raw,
  };
}

interface NextLink { rel: string; href: string; method?: string; body?: Record<string, unknown>; merge?: boolean }
export interface StacProviderOptions {
  id: string;
  baseUrl: string;
  collections: string[];
  fetchImpl?: typeof fetch;
}
export class StacProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly collections: string[];
  private readonly fetchImpl: typeof fetch;
  constructor(options: StacProviderOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.collections = [...options.collections];
    this.fetchImpl = options.fetchImpl ?? fetch;
    const url = new URL(this.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new SatelliteError("INVALID_PROVIDER", "Provider must use HTTPS except localhost", this.id);
    }
  }

  async *search(query: SearchQuery): AsyncGenerator<SearchPage> {
    const maxPages = query.maxPages ?? 3;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
      throw new SatelliteError("INVALID_QUERY", "maxPages must be between 1 and 50");
    }
    let body = makeBody(query, this.collections);
    let href = this.baseUrl + "/search";
    let method = "POST";
    const seen = new Set<string>();
    for (let index = 0; index < maxPages; index++) {
      const requestId = JSON.stringify([href,method,body]);
      if (seen.has(requestId)) throw new SatelliteError("PAGINATION_LOOP", "Repeating STAC next link", this.id);
      seen.add(requestId);
      let response: Response;
      try {
        response = await this.fetchImpl(href, {
          method,
          headers: { "Accept": "application/geo+json, application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          body: method === "POST" ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        throw new SatelliteError("NETWORK", "STAC request failed: " + String(error), this.id);
      }
      if (!response.ok) throw new SatelliteError("HTTP_ERROR", "STAC API returned HTTP " + response.status, this.id);
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new SatelliteError("INVALID_RESPONSE", "STAC response was not valid JSON", this.id); }
      const page = object(data);
      if (!Array.isArray(page.features)) throw new SatelliteError("INVALID_RESPONSE", "STAC response lacks a features array", this.id);
      const links = (Array.isArray(page.links) ? page.links : []).map(object);
      const next = links.find((link) => link.rel === "next") as unknown as NextLink | undefined;
      const matched = object(page.context).matched ?? object(page.numberMatched).value;
      const scenes = page.features.map((feature) => normalise(feature, this.id));
      yield { providerId:this.id, items:scenes, pageNumber:index+1, hasNext:Boolean(next), matched: typeof matched === "number" ? matched : (typeof page.numberMatched === "number" ? page.numberMatched : null) };
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
        body = next.merge === false ? nextBody : { ...body, ...nextBody };
      }
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
    collections:["sentinel-2-l2a","landsat-c2-l2"], fetchImpl,
  });
}

export class SatelliteCatalog {
  constructor(private readonly providers: StacProvider[]) {
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
  async upcoming(): Promise<AcquisitionOpportunity[]> {
    throw new SatelliteError("UNSUPPORTED", "Future acquisition planning is not implemented in version 0.1");
  }
}
