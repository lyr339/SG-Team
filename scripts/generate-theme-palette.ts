import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderThemePaletteCSS } from '../src/renderer/src/theme-palette'

const path = resolve('src/renderer/src/theme-palette.generated.css')
writeFileSync(path, renderThemePaletteCSS())
console.log(`Generated ${path}`)
