import { replyBodyMaterial } from '../../../domain/reply-body-proof'
import type { NotificationScope } from '../../../domain/notification'
/** WebCrypto only; no API request, source refresh or plaintext persistence. */
export async function replyBodyDigest(text: string, scope: NotificationScope): Promise<string | undefined> {
  const material = replyBodyMaterial(text, scope)
  if (!material || !window.crypto?.subtle) return
  try { const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
  catch { return undefined }
}
