import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require=createRequire(import.meta.url)
const {trayIconSvg,rasterIconSvg,RASTER_SRC}=require('../docs/design/sg-monogram/icon-lib.cjs')
const source=(name:string)=>readFileSync(join(process.cwd(),'docs/design/sg-monogram',name)).toString('base64')
const shipped=(name:string)=>{const file=readFileSync(join(process.cwd(),'build',name),'utf8').replaceAll('\r\n','\n');return file.slice(file.indexOf('<svg'))}
describe('current icon generators match shipped design assets',()=>{
  it('retains the exact tray geometry after retiring the unused colored vector branch',()=>{
    expect(trayIconSvg({mono:'#000',monoBeamFactor:3})).toBe(shipped('trayTemplate.svg'))
  })
  it('retains both platform sizes from the approved raster sources',()=>{
    const master=source('v12-master.png'),small=source('v12-small.png')
    expect(rasterIconSvg(master)).toBe(shipped('icon-shiguang.svg'))
    expect(rasterIconSvg(master,{scale:1.135,tileShadow:false})).toBe(shipped('icon-shiguang-win.svg'))
    expect(rasterIconSvg(small,{src:RASTER_SRC.small,tileShadow:false})).toBe(shipped('icon-shiguang-small.svg'))
    expect(rasterIconSvg(small,{scale:1.135,src:RASTER_SRC.small,tileShadow:false})).toBe(shipped('icon-shiguang-win-small.svg'))
  })
})
