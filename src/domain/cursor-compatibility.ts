/** Explicitly audited Cursor releases; a version match never replaces bundle capability checks. */
export const SUPPORTED_CURSOR_VERSIONS = ['3.6.31', '3.21.12'] as const
export type SupportedCursorVersion = typeof SUPPORTED_CURSOR_VERSIONS[number]

export interface CursorCompatibility {
  state: 'supported' | 'unsupported' | 'unavailable'
  version?: string
  adapter?: SupportedCursorVersion
  detail: string
}

export function cursorCompatibilityForVersion(version: unknown): CursorCompatibility {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { state: 'unavailable', detail: '无法确认 Cursor 版本；请检查所用安装是否完整' }
  }
  const adapter = SUPPORTED_CURSOR_VERSIONS.find((supported) => supported === version)
  return adapter
    ? { state: 'supported', version, adapter, detail: '自动匹配对应补丁，无需手动选择版本' }
    : { state: 'unsupported', version, detail: `暂未适配 Cursor ${version}；当前支持 ${SUPPORTED_CURSOR_VERSIONS.join('、')}` }
}
