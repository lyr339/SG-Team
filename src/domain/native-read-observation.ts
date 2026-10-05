/** Main-only provenance of an already completed service read; not an auth token or a request to probe. */
export interface NativeReadStamp {
  owner: string
  sequence: number
}
