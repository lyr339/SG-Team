/** jsdom 不实现原生 DnD：合成带 dataTransfer 存根的 drag 事件（名册拖拽两套测试共用）。 */
export function dragEvent(type: string, clientY = 0, clientX = 100): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const store = new Map<string, string>()
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY }
  })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (format: string, value: string) => store.set(format, value),
      getData: (format: string) => store.get(format) ?? ''
    }
  })
  return event
}
