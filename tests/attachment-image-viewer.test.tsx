// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageAttachment } from '../src/domain/conversation-entry'
import { AttachmentThumbnail, useAttachmentActions } from '../src/renderer/src/AttachmentImageViewer'

const attachment: MessageAttachment = {
  id: 'att-1',
  name: 'screen.png',
  mimeType: 'image/png',
  size: 76_288,
  previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
  path: '/Users/x/Library/Application Support/sg-team/channel-attachments/m1/screen.png'
}

describe('AttachmentThumbnail', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as unknown as { sgDesktop?: unknown }).sgDesktop
  })

  it('renders a zoomable button and nothing when the attachment has no image source', () => {
    const html = renderToStaticMarkup(<AttachmentThumbnail attachment={attachment} className="chat-attachment-image" />)
    expect(html).toContain('class="attachment-thumb chat-attachment-image"')
    expect(html).toContain('点击查看大图，右键更多操作')
    expect(renderToStaticMarkup(<AttachmentThumbnail attachment={{ ...attachment, previewUrl: undefined }} />)).toBe('')
  })

  it('opens the lightbox on click, copies through the desktop API and closes on Escape', async () => {
    const copyImageToClipboard = vi.fn(async () => true)
    ;(window as unknown as { sgDesktop?: unknown }).sgDesktop = { copyImageToClipboard, saveImageAs: vi.fn(), revealPathInFolder: vi.fn() }
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment} />))
    await act(async () => { container.querySelector<HTMLButtonElement>('.attachment-thumb')!.click() })
    const lightbox = document.querySelector('.attachment-lightbox')
    expect(lightbox).not.toBeNull()
    expect(lightbox?.textContent).toContain('screen.png')
    expect(lightbox?.textContent).toContain('74.5 KB')
    // 已落盘的附件多出「在文件夹中显示」
    expect(lightbox?.textContent).toContain('在文件夹中显示')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-lightbox__actions button')].find((b) => b.textContent === '复制图片')!.click() })
    expect(copyImageToClipboard).toHaveBeenCalledWith({ dataUrl: attachment.previewUrl })
    expect(document.querySelector('.attachment-lightbox__feedback')?.textContent).toBe('已复制到剪贴板')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.attachment-lightbox')).toBeNull()
  })

  it('opens a context menu on right click with copy/save/reveal and an optional remove entry', async () => {
    const onRemove = vi.fn()
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment} onRemove={onRemove} />))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.attachment-thumb')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }))
    })
    const labels = [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].map((b) => b.textContent)
    expect(labels).toEqual(['查看大图', '复制图片', '另存为…', '在文件夹中显示', '移除附件'])
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].at(-1)!.click() })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.attachment-menu')).toBeNull()
  })
  it('lightbox takes focus, cycles Tab inside and returns to its thumbnail on Escape', async () => {
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment}/>))
    const opener=container.querySelector<HTMLButtonElement>('.attachment-thumb')!
    opener.focus();await act(async () => opener.click())
    const box=document.querySelector<HTMLElement>('.attachment-lightbox')!
    const buttons=[...box.querySelectorAll<HTMLButtonElement>('button')]
    expect(box.contains(document.activeElement)).toBe(true)
    buttons.at(-1)!.focus()
    await act(async () => buttons.at(-1)!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})))
    expect(document.activeElement).toBe(buttons[0])
    await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})))
    expect(document.activeElement).toBe(buttons.at(-1))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
    expect(document.activeElement).toBe(opener)
  })
  it('context menu supports keyboard selection and Escape without closing a parent surface', async () => {
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment}/>))
    const opener=container.querySelector<HTMLButtonElement>('.attachment-thumb')!
    opener.focus()
    await act(async () => opener.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:50})))
    const menu=document.querySelector<HTMLElement>('.attachment-menu')!
    expect(menu.contains(document.activeElement)).toBe(true)
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true})))
    expect(document.activeElement?.textContent).toBe('在文件夹中显示')
    const outer=vi.fn();window.addEventListener('keydown',outer)
    try {await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(outer).not.toHaveBeenCalled()}
    finally {window.removeEventListener('keydown',outer)}
    expect(document.querySelector('.attachment-menu')).toBeNull();expect(document.activeElement).toBe(opener)
  })
  it('an old attachment result cannot appear on a replacement image', async () => {
    let resolve!: (value:boolean)=>void
    ;(window as unknown as {sgDesktop:unknown}).sgDesktop={copyImageToClipboard:()=>new Promise<boolean>(done=>{resolve=done})}
    function Harness({value}:{value:MessageAttachment}) {const actions=useAttachmentActions(value);return <><button onClick={()=>void actions.copy()}>copy</button><span>{actions.feedback}</span></>}
    await act(async () => root.render(<Harness value={attachment}/>))
    await act(async () => container.querySelector('button')!.click())
    await act(async () => root.render(<Harness value={{...attachment,id:'att-2',name:'second.png'}}/>))
    await act(async () => resolve(true))
    expect(container.querySelector('span')!.textContent).toBe('')
  })
  it('a late attachment response after unmount creates no feedback timer', async () => {
    let resolve!: (value:boolean)=>void
    ;(window as unknown as {sgDesktop:unknown}).sgDesktop={copyImageToClipboard:()=>new Promise<boolean>(done=>{resolve=done})}
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment}/>))
    await act(async () => container.querySelector<HTMLButtonElement>('.attachment-thumb')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.attachment-lightbox__actions button')!.click())
    await act(async () => root.render(null))
    const timer=vi.spyOn(window,'setTimeout')
    try {await act(async () => resolve(true));expect(timer).not.toHaveBeenCalled()} finally {timer.mockRestore()}
  })

})
