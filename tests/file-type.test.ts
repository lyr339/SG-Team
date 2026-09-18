import { describe, expect, it } from 'vitest'
import { fileIconKind } from '../src/renderer/src/file-type'

describe('file-type · 扩展名归图标族', () => {
  it('tsx/jsx 归 React（看框架不看语言），未知扩展名与无扩展名给通用文件', () => {
    expect(fileIconKind('.ts')).toBe('typescript')
    expect(fileIconKind('.TSX')).toBe('react')
    expect(fileIconKind('.jsx')).toBe('react')
    expect(fileIconKind('.mjs')).toBe('javascript')
    expect(fileIconKind('.json')).toBe('json')
    expect(fileIconKind('.scss')).toBe('styles')
    expect(fileIconKind('.md')).toBe('markdown')
    expect(fileIconKind('.html')).toBe('markup')
    expect(fileIconKind('.svg')).toBe('markup')
    expect(fileIconKind('.png')).toBe('image')
    expect(fileIconKind('.ps1')).toBe('shell')
    expect(fileIconKind('.yml')).toBe('config')
    expect(fileIconKind('.py')).toBe('code')
    expect(fileIconKind('.longext')).toBe('file')
    expect(fileIconKind('')).toBe('file')
  })

  it('带点、不带点、大小写混合都认同一个扩展名', () => {
    expect(fileIconKind('ts')).toBe('typescript')
    expect(fileIconKind('.Md')).toBe('markdown')
    expect(fileIconKind('JSON')).toBe('json')
  })
})
