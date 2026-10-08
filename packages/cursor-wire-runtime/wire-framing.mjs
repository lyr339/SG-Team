import { gunzipSync, gzipSync } from "node:zlib";

export function encodeEnvelope(
  payload,
  { compress = false, end = false } = {},
) {
  const body = compress ? gzipSync(payload) : Buffer.from(payload),
    header = Buffer.alloc(5);
  header[0] = (compress ? 1 : 0) | (end ? 2 : 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  constructor({ compression = "identity", maxBytes = 4 * 1024 * 1024 } = {}) {
    this.compression = compression;
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.terminal = false;
  }
  push(chunk) {
    if (this.terminal && chunk.length) throw Error("Data after EndStream");
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const output = [];
    while (this.buffer.length >= 5) {
      const flags = this.buffer[0],
        size = this.buffer.readUInt32BE(1);
      if (flags & ~3 || size > this.maxBytes)
        throw Error("Invalid or oversized Connect envelope");
      if (this.buffer.length < size + 5) break;
      let payload = this.buffer.subarray(5, size + 5);
      this.buffer = this.buffer.subarray(size + 5);
      if (flags & 1) {
        if (this.compression !== "gzip")
          throw Error("Unsupported envelope compression");
        payload = gunzipSync(payload, { maxOutputLength: this.maxBytes });
      }
      const end = !!(flags & 2);
      output.push({ flags, payload, end });
      if (end) {
        this.terminal = true;
        if (this.buffer.length) throw Error("Data after EndStream");
        break;
      }
    }
    if (this.buffer.length > this.maxBytes + 5)
      throw Error("Framing buffer limit");
    return output;
  }
  finish({ requireEnd = true } = {}) {
    if (this.buffer.length) throw Error("Truncated Connect envelope");
    if (requireEnd && !this.terminal) throw Error("Missing EndStream");
  }
}
