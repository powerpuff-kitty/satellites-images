export class SatelliteError extends Error {
  constructor(public readonly code: string, message: string, public readonly providerId?: string) {
    super(message);
    this.name = "SatelliteError";
  }
}
