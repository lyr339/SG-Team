import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 4 * 1024 * 1024;
function readBounded(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw Error("Invalid or oversized wire state file");
  return readFileSync(path);
}
function atomic(path, body) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
    // Windows FlushFileBuffers requires a writable handle. Keep the fsync
    // durability gate; a read-only handle is accepted on POSIX but fails there.
    const fd = openSync(temp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    try {
      const fd = openSync(dirname(path), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* Windows directory handles may be unavailable. */
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory())
    throw Error("Wire storage must be a real directory");
  chmodSync(path, 0o700);
}
export class WireStore {
  constructor(
    directory,
    { accountScope, conversationId, backend = "wire" } = {},
  ) {
    this.directory = directory;
    privateDirectory(directory);
    privateDirectory(join(directory, "blobs"));
    const path = join(directory, "session.json");
    if (existsSync(path)) {
      this.metadata = JSON.parse(readBounded(path));
      if (
        !this.metadata ||
        !Array.isArray(this.metadata.runs) ||
        this.metadata.runs.length > 40 ||
        typeof this.metadata.conversationId !== "string"
      )
        throw Error("Invalid wire session metadata");
      if (
        this.metadata.accountScope !== accountScope ||
        this.metadata.backend !== backend
      )
        throw Error("Session account/backend mismatch");
      if (conversationId && conversationId !== this.metadata.conversationId)
        throw Error("Conversation identity mismatch");
    } else {
      if (!accountScope || !conversationId)
        throw Error("New session requires identity");
      this.metadata = {
        accountScope,
        conversationId,
        backend,
        createdAt: Date.now(),
        runs: [],
      };
      atomic(path, JSON.stringify(this.metadata));
    }
  }
  blobPath(id) {
    if (!(id instanceof Uint8Array) || id.length !== 32)
      throw Error("Invalid blob ID");
    return join(
      this.directory,
      "blobs",
      Buffer.from(id).toString("hex") + ".bin",
    );
  }
  setBlob(id, data) {
    if (!(data instanceof Uint8Array) || data.length > MAX_BYTES)
      throw Error("Invalid or oversized blob");
    const path = this.blobPath(id);
    if (!createHash("sha256").update(data).digest().equals(Buffer.from(id)))
      throw Error("Blob SHA-256 mismatch");
    if (existsSync(path)) {
      this.getBlob(id);
      return;
    }
    atomic(path, Buffer.from(data));
  }
  getBlob(id) {
    const path = this.blobPath(id);
    if (!existsSync(path)) return undefined;
    const data = readBounded(path);
    if (!createHash("sha256").update(data).digest().equals(Buffer.from(id)))
      throw Error("Stored blob SHA-256 mismatch");
    return data;
  }
  saveCheckpoint(data) {
    const id = createHash("sha256").update(data).digest();
    this.setBlob(id, data);
    const next = { ...this.metadata, checkpointId: id.toString("hex") };
    atomic(join(this.directory, "session.json"), JSON.stringify(next));
    this.metadata = next;
  }
  checkpoint() {
    if (this.metadata.checkpointId) {
      if (!/^[a-f0-9]{64}$/.test(this.metadata.checkpointId))
        throw Error("Invalid checkpoint reference");
      const data = this.getBlob(Buffer.from(this.metadata.checkpointId, "hex"));
      if (!data) throw Error("Committed checkpoint is missing");
      return data;
    }
    const path = join(this.directory, "checkpoint.bin");
    return existsSync(path) ? readBounded(path) : null;
  }
  recordRun(result, checkpoint) {
    if (this.metadata.runs.length >= 40)
      throw Error("Wire session turn limit reached");
    const next = { ...this.metadata, runs: [...this.metadata.runs, result] };
    if (checkpoint) {
      const id = createHash("sha256").update(checkpoint).digest();
      this.setBlob(id, checkpoint);
      next.checkpointId = id.toString("hex");
    }
    // Successful turn + resumable checkpoint commit together; failed turns never advance it.
    atomic(join(this.directory, "session.json"), JSON.stringify(next));
    this.metadata = next;
  }
}
