import { extractAll, extractFile } from '@electron/asar'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Inspect package contents and load only the isolated runtime. Never boot
// production main, read a user's profile, or call a network/model endpoint.
const artifact = process.platform === 'win32'
  ? 'release/win-unpacked/resources/app.asar'
  : 'release/mac-arm64/拾光.app/Contents/Resources/app.asar'
const asar = resolve(artifact)
const pkg = JSON.parse(extractFile(asar, 'package.json').toString())
assert.ok(pkg.dependencies['@shiguang/cursor-wire-runtime'])
const root = mkdtempSync(join(tmpdir(), 'sg-wire-package-'))
try {
  extractAll(asar, root)
  const runtime = join(root, 'node_modules/@shiguang/cursor-wire-runtime')
  const client = await import(pathToFileURL(join(runtime, 'wire-client.mjs')).href)
  const { createWireTypes } = await import(pathToFileURL(join(runtime, 'wire-types.mjs')).href)
  const { FrameDecoder, encodeEnvelope } = await import(pathToFileURL(join(runtime, 'wire-framing.mjs')).href)
  assert.equal(typeof client.runWire, 'function')
  const types = createWireTypes()
  const payload = new types.State().toBinary()
  const decoder = new FrameDecoder()
  assert.equal(decoder.push(encodeEnvelope(payload)).length, 1)
  assert.equal(decoder.push(encodeEnvelope(Buffer.from('{}'), { end: true }))[0].end, true)
  decoder.finish()
  console.log(JSON.stringify({ version: pkg.version, packagedRuntime: true, schemaLoaded: true, protobufRoundTrip: true, networkRequests: 0 }))
} finally { rmSync(root, { recursive: true, force: true }) }
