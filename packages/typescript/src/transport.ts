import { SatelliteError } from "./errors.js";

/** Enforce the byte ceiling while streaming, including responses without Content-Length. */
export async function readTextBounded(response: Response, maxBytes: number, providerId: string): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new SatelliteError("INVALID_RESPONSE", "Provider response exceeds size limit", providerId);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SatelliteError("INVALID_RESPONSE", "Provider response exceeds size limit", providerId);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
