import type { Scene, SceneAsset } from "@powerpuff-kitty/satellites-images";

export type PreviewCorner = [number, number];
export interface PublicPreview {
  image: string | null;
  tiles: string | null;
  coordinates: [PreviewCorner, PreviewCorner, PreviewCorner, PreviewCorner] | null;
  origin: string;
}
const PRIORITY = ["rendered_preview", "overview", "visual", "preview", "quicklook", "thumbnail"];
const IMAGE = /^image\/(jpeg|png|webp|avif|gif)(;|$)/i;
const EXTENSION = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;
const PC = "https://planetarycomputer.microsoft.com/api/stac/v1";
const ODATA = "https://catalogue.dataspace.copernicus.eu/odata/v1";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
export function publicUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function displayable(asset: SceneAsset): boolean {
  if (!publicUrl(asset.href) || ["authentication-required", "payment-required"].includes(asset.access)) return false;
  // A declared GeoTIFF/JP2/HTML type takes precedence over a misleading file extension.
  return asset.type ? IMAGE.test(asset.type) : EXTENSION.test(asset.href);
}
function rank(asset: SceneAsset): number {
  const keys = [asset.key, ...asset.roles].map(key => key.toLowerCase());
  const index = PRIORITY.findIndex(key => keys.includes(key));
  return index < 0 ? PRIORITY.length : index;
}
export function previewAssetFor(scene: Scene): SceneAsset | null {
  return [...scene.assets].filter(asset => displayable(asset) && !requiresAuthentication(scene, asset))
    .sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
function requiresAuthentication(scene: Scene, asset: SceneAsset): boolean {
  const refs = object(object(scene.raw.assets)[asset.key])["auth:refs"];
  return Array.isArray(refs) && refs.length > 0;
}
export function previewUrlFor(scene: Scene): string | null {
  const asset = previewAssetFor(scene);
  if (asset) return asset.href;
  if (scene.assets.some(candidate => candidate.href === scene.previewUrl &&
      (!displayable(candidate) || requiresAuthentication(scene, candidate)))) return null;
  const href = publicUrl(scene.previewUrl);
  if (!href || /\.(tiff?|jp2)(\?|#|$)/i.test(href)) return null;
  // A preview link declaring HTML is a provider viewer, not an image.
  const links = scene.raw.links;
  if (Array.isArray(links) && links.some(link => object(link).href === href &&
      text(object(link).type) && !IMAGE.test(String(object(link).type)))) return null;
  return href;
}
export function tileAssetFor(scene: Scene): string | null {
  return scene.assets.find(asset => asset.roles.includes("tiles") && publicUrl(asset.href) &&
    !["authentication-required", "payment-required"].includes(asset.access) && !requiresAuthentication(scene, asset))?.href ?? null;
}
function productName(scene: Scene): string | null {
  const properties = object(scene.raw.properties);
  const name = text(properties["s2:product_uri"]) ?? text(properties["sentinel:product_id"]) ?? scene.id;
  return /^S2[ABC]_MSIL[12][AC]_\d{8}T\d{6}_N\d{4}_R\d{3}_T[A-Z0-9]{5}_\d{8}T\d{6}(\.SAFE)?$/.test(name)
    ? name.replace(/\.SAFE$/, "") + ".SAFE" : null;
}
export function canDiscoverPreview(scene: Scene): boolean {
  return scene.providerId === "copernicus" && productName(scene) !== null;
}
export function hasPublicPreview(scene: Scene): boolean {
  const found = cache.get(scene);
  return Boolean(found?.image || found?.tiles || previewUrlFor(scene) || tileAssetFor(scene));
}
export function canViewPreview(scene: Scene): boolean {
  return hasPublicPreview(scene) || canDiscoverPreview(scene) ||
    (scene.providerId === "earth-search" && ["landsat-c2-l2", "sentinel-2-l2a"].includes(scene.collection));
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? "The public preview is unavailable or requires an account." : "The preview service is temporarily unavailable.");
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("The preview response is too large."); }
  if (!response.body) throw new Error("The preview service returned an empty response.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("The preview response is too large.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function json(url: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal, credentials: "omit", redirect: "error",
    ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return object(JSON.parse(new TextDecoder().decode(await readBounded(response, 1024 * 1024))));
}
function assetsFromItem(item: Record<string, unknown>): SceneAsset[] {
  return Object.entries(object(item.assets)).map(([key, value]) => {
    const asset = object(value);
    const auth = asset["auth:refs"];
    return { key, href: String(asset.href ?? ""), type: text(asset.type),
      roles: Array.isArray(asset.roles) ? asset.roles.filter((role): role is string => typeof role === "string") : [],
      access: Array.isArray(auth) && auth.length ? "authentication-required" : "unknown" };
  });
}
function fromScene(scene: Scene, origin: string): PublicPreview {
  // Only an explicit image projection can place a still image; a scene footprint cannot.
  const asset = previewAssetFor(scene);
  const native = object(object(scene.raw.assets)[asset?.key ?? ""]);
  const bbox = native["proj:bbox"];
  const transform = native["proj:transform"];
  const northUp = Array.isArray(transform) && [6, 9].includes(transform.length) &&
    transform.every(value => typeof value === "number" && Number.isFinite(value)) &&
    transform[0] > 0 && transform[4] < 0 && transform[1] === 0 && transform[3] === 0 &&
    (transform.length === 6 || (transform[6] === 0 && transform[7] === 0 && transform[8] === 1));
  let coordinates: PublicPreview["coordinates"] = null;
  if ((native["proj:code"] === "EPSG:4326" || native["proj:epsg"] === 4326) &&
      northUp && Array.isArray(bbox) && bbox.length === 4 && bbox.every(value => typeof value === "number" && Number.isFinite(value))) {
    const [w, s, e, n] = bbox as number[];
    if (w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n)
      coordinates = [[w, n], [e, n], [e, s], [w, s]];
  }
  return { image: previewUrlFor(scene), tiles: tileAssetFor(scene), coordinates, origin };
}
const cache = new WeakMap<Scene, PublicPreview>();
export function forgetPublicPreview(scene: Scene): void { cache.delete(scene); }
export async function discoverPublicPreview(scene: Scene, signal: AbortSignal, skipDirect = false): Promise<PublicPreview> {
  const cached = cache.get(scene);
  if (cached && !skipDirect) return cached;
  const own = fromScene(scene, scene.providerId);
  if (own.tiles) return own;
  if (scene.providerId === "earth-search" ||
      (scene.providerId === "planetary-computer" && scene.collection === "landsat-c2-l2")) {
    // Resolve the matching product, then use advertised assets rather than invented rendering URLs.
    try {
      let item: Record<string, unknown> | undefined;
      if (scene.collection === "landsat-c2-l2") {
        item = await json(PC + "/collections/landsat-c2-l2/items/" + encodeURIComponent(scene.id), signal);
        if (item.id !== scene.id || item.collection !== scene.collection) item = undefined;
      } else if (scene.collection === "sentinel-2-l2a") {
        const properties = object(scene.raw.properties);
        const tile = text(properties["s2:mgrs_tile"]) ?? text(properties["grid:code"])?.replace(/^MGRS-/, "") ??
          /_T(\d{2}[A-Z]{3})_/.exec(productName(scene) ?? "")?.[1];
        if (tile) {
          const day = scene.acquiredAt.slice(0, 10);
          const result = await json(PC + "/search", signal, { collections: [scene.collection],
            filter: { op: "=", args: [{ property: "s2:mgrs_tile" }, tile] },
            datetime: day + "T00:00:00Z/" + day + "T23:59:59Z", limit: 10 });
          const matches = (Array.isArray(result.features) ? result.features : []).map(object).filter(candidate => {
            const props = object(candidate.properties);
            const sameTile = props["s2:mgrs_tile"] === tile || props["grid:code"] === "MGRS-" + tile;
            const product = productName(scene);
            return candidate.collection === scene.collection && sameTile && (product
              ? props["s2:product_uri"] === product
              : Date.parse(String(props.datetime)) === Date.parse(scene.acquiredAt));
          });
          if (matches.length === 1) item = matches[0];
        }
      }
      if (item) {
        const matched = fromScene({ ...scene, assets: assetsFromItem(item), previewUrl: null, raw: item }, "planetary-computer");
        if (matched.image || matched.tiles) { cache.set(scene, matched); return matched; }
      }
    } catch (error) { if (signal.aborted) throw error; /* Keep the original public preview when matching fails. */ }
  }
  if (own.image && (!skipDirect || !canDiscoverPreview(scene))) return own;
  if (canDiscoverPreview(scene)) {
    const name = productName(scene)!;
    const parameters = new URLSearchParams({ "$filter": "Name eq '" + name + "'", "$expand": "Assets", "$top": "2" });
    const result = await json(ODATA + "/Products?" + parameters, signal);
    const products = (Array.isArray(result.value) ? result.value : []).map(object).filter(product => product.Name === name);
    if (products.length === 1) {
      const assets = products[0].Assets;
      for (const entry of Array.isArray(assets) ? assets : []) {
        const asset = object(entry), href = publicUrl(asset.DownloadLink);
        if (asset.Type === "QUICKLOOK" && href && new URL(href).origin === new URL(ODATA).origin &&
            /^\/odata\/v1\/Assets\([a-f0-9-]{36}\)\/\$value$/i.test(new URL(href).pathname)) {
          const found = { image: href, tiles: null, coordinates: null, origin: "Copernicus OData" };
          cache.set(scene, found); return found;
        }
      }
    }
  }
  return { image: null, tiles: null, coordinates: null, origin: scene.providerId };
}
export async function fetchOverlayImage(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { mode: "cors", cache: "reload", credentials: "omit", signal });
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!IMAGE.test(type)) { await response.body?.cancel(); throw new Error("The preview response is not a browser image."); }
  const bytes = await readBounded(response, 8 * 1024 * 1024);
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
}
