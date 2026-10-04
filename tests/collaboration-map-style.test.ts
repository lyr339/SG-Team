import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
const css=readFileSync(new URL('../src/renderer/src/team/collaboration-map.css',import.meta.url),'utf8')
const rgb=(hex:string):number[]=>[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16))
const luminance=(rgb:number[]):number=>rgb.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i]!,0)
const contrast=(fore:number[],back:number[],opacity=1):number=>{
 const l=luminance(fore.map((n,i)=>n*opacity+back[i]!*(1-opacity))),b=luminance(back)
 return (Math.max(l,b)+.05)/(Math.min(l,b)+.05)
}
describe('collaboration map surface contracts',()=>{
 it('normal historical routes remain readable in light and dark paper, not faint decoration',()=>{
  const colors=css.match(/--collaboration-history:\s*light-dark\(#([\da-f]{6}),\s*#([\da-f]{6})\)/i)!
  const opacity=Number(css.match(/\[data-kind="history"\] \.collaboration-wire__silk\s*\{[^}]*opacity:\s*([.\d]+)/)![1])
  const backgrounds=[[254.22,254.4,254.64],[23.64,28.64,36.7]]
  for(let i=0;i<2;i++)expect(contrast(rgb(colors[i+1]!),backgrounds[i]!,opacity)).toBeGreaterThanOrEqual(3)
 })
 it('keeps motion reduced and transitions local, with no wholesale CSS overrides',()=>{
  expect(css).not.toContain('transition: all')
  expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  expect(css).toContain('.collaboration-entry__open, .collaboration-dialog__goal summary svg { transition: none; }')
  expect(css).toContain('scroll-padding-block: 58px 16px')
  expect(css).toContain('content-visibility: auto')
  expect(css).toContain('overscroll-behavior-x: contain; overscroll-behavior-y: auto')
 })
})
