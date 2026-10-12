import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root=process.cwd()
const markdown=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?markdown(join(directory,entry.name)):entry.name.endsWith('.md')?[join(directory,entry.name)]:[])
describe('repository maintenance boundaries',()=>{
  it('keeps documentation links resolvable after retiring old handoffs',()=>{
    for(const file of [join(root,'README.md'),...markdown(join(root,'docs'))]){
      const text=readFileSync(file,'utf8')
      for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
        const link=match[1]!
        if(/^[a-z][a-z0-9+.-]*:/i.test(link)||link.startsWith('#'))continue
        expect(existsSync(resolve(dirname(file),link.split('#')[0]!)),`${file}: ${link}`).toBe(true)
      }
    }
  })
  it('retains active packaging resources without treating every scratch script as an entry point',()=>{
    const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
    for(const path of [pkg.build.mac.icon,pkg.build.win.icon,...pkg.build.extraResources.map((item:{from:string})=>item.from).filter((path:string)=>path.startsWith('build/'))])expect(existsSync(join(root,path)),path).toBe(true)
    expect(pkg.dependencies['@shiguang/cursor-wire-runtime']).toBe('file:packages/cursor-wire-runtime')
    expect(existsSync(join(root,'packages/cursor-wire-runtime/package.json'))).toBe(true)
    const config=JSON.parse(readFileSync(join(root,'knip.json'),'utf8'))
    expect(config.workspaces['.'].entry).not.toContain('scripts/*.{ts,mjs}')
    expect(config.workspaces['.'].entry).toContain('src/renderer/src/main.tsx!')
    expect(pkg.scripts['lint:dead']).toContain('--production --include files')
    expect(config.workspaces['.'].project).toContain('docs/design/sg-monogram/*.cjs')
  })
})
