import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')
const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')
describe('two-check release contract',()=>{
  it('keeps both native gates and publishes only after macOS and Windows succeed',()=>{
    const jobs=release.split('\njobs:\n')[1]??''
    expect([...jobs.matchAll(/^ {2}([a-z]+):\r?$/gm)].map(match=>match[1])).toEqual(['mac','windows'])
    expect(release).toContain('needs: mac')
    expect(release.match(/run: npm test/g)).toHaveLength(2)
    expect(release.match(/run: npm run smoke:wire:packaged/g)).toHaveLength(2)
    expect(release).toContain('runs-on: macos-latest');expect(release).toContain('runs-on: windows-latest')
    expect(release).not.toContain('continue-on-error: true')
    expect(release).toContain('gh release create');expect(release).toContain('release/latest.yml')
  })
  it('does not duplicate release checks on a main push but retains PR verification',()=>{
    expect(ci).toContain('  pull_request:')
    expect(ci).not.toMatch(/^\s+push:/m)
    expect(ci).toContain('os: [macos-latest, windows-latest]')
    expect(release).toContain("tags: ['v*']")
  })
})
