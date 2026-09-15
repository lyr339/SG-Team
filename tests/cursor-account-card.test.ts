import { describe, expect, it } from 'vitest'
import { detectPastedSecret, parseCursorAccountCard } from '../src/domain/cursor-account-card'

function fakeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(payload)}.signature`
}

const SESSION_JWT = fakeJwt({
  sub: 'auth0|user_01M25BW24N47AXMGKW2X7GCZY0',
  exp: 1_794_218_127,
  iss: 'https://authentication.cursor.sh',
  type: 'session'
})
const SESSION_TOKEN = `user_01M25BW24N47AXMGKW2X7GCZY0::${SESSION_JWT}`

function cardText(overrides: { token?: string; email?: string; cursorPassword?: string } = {}): string {
  return [
    overrides.email ?? 'ElliotMooreeza@outlook.com',
    'bzzakg51715',
    overrides.cursorPassword ?? '#sXsc5lzoC0d',
    'bht5wyvxpz@ouleyx.cc',
    'TopazTopaz4479@',
    overrides.token ?? SESSION_TOKEN
  ].join('----')
}

describe('detectPastedSecret', () => {
  it('按分隔符识别卡号与单独 Token', () => {
    expect(detectPastedSecret('')).toBe('empty')
    expect(detectPastedSecret('   ')).toBe('empty')
    expect(detectPastedSecret('user_abc::jwt')).toBe('token')
    expect(detectPastedSecret(cardText())).toBe('card')
  })
})

describe('parseCursorAccountCard', () => {
  it('解析完整六段卡号：字段、默认备注、JWT 身份与有效期', () => {
    const card = parseCursorAccountCard(cardText())
    expect(card).toEqual({
      email: 'ElliotMooreeza@outlook.com',
      label: 'ElliotMooreeza@outlook.com',
      emailPassword: 'bzzakg51715',
      cursorPassword: '#sXsc5lzoC0d',
      recoveryEmail: 'bht5wyvxpz@ouleyx.cc',
      recoveryEmailPassword: 'TopazTopaz4479@',
      token: SESSION_TOKEN,
      userId: 'user_01M25BW24N47AXMGKW2X7GCZY0',
      sub: 'auth0|user_01M25BW24N47AXMGKW2X7GCZY0',
      expiresAt: 1_794_218_127_000
    })
  })

  it('Token 段为 URL 编码时自动解码', () => {
    const encoded = SESSION_TOKEN.replace('::', '%3A%3A')
    expect(parseCursorAccountCard(cardText({ token: encoded })).token).toBe(SESSION_TOKEN)
  })

  it('容忍整段首尾空白与各段间隙空白', () => {
    const card = parseCursorAccountCard(`\n  ${cardText().split('----').join(' ---- ')}  \n`)
    expect(card.email).toBe('ElliotMooreeza@outlook.com')
    expect(card.cursorPassword).toBe('#sXsc5lzoC0d')
  })

  it('辅邮两段留空时缺省（部分卡号不带辅邮）', () => {
    const text = ['a@b.co', 'mailpass', 'cursorpass', '', '', SESSION_TOKEN].join('----')
    const card = parseCursorAccountCard(text)
    expect(card.recoveryEmail).toBeUndefined()
    expect(card.recoveryEmailPassword).toBeUndefined()
    expect(card.emailPassword).toBe('mailpass')
  })

  it('段数不符时报出实际段数', () => {
    expect(() => parseCursorAccountCard('a@b.co----x----y')).toThrowError(/6 段.*3 段/)
    expect(() => parseCursorAccountCard('')).toThrowError(/请粘贴卡号内容/)
  })

  it('邮箱、Cursor 密码、Token 缺失或非法时按字段位置报错', () => {
    expect(() => parseCursorAccountCard(cardText({ email: 'not-an-email' }))).toThrowError(/第 1 段（邮箱）/)
    expect(() => parseCursorAccountCard(cardText({ cursorPassword: '' }))).toThrowError(/第 3 段（Cursor 密码）为空/)
    expect(() => parseCursorAccountCard(cardText({ token: '' }))).toThrowError(/第 6 段（Token）为空/)
    expect(() => parseCursorAccountCard(cardText({ token: 'not-a-jwt' }))).toThrowError(/第 6 段（Token）不是有效/)
  })

  it('纯 JWT（无 user_ 前缀）同样可解析，userId 缺省', () => {
    const card = parseCursorAccountCard(cardText({ token: SESSION_JWT }))
    expect(card.token).toBe(SESSION_JWT)
    expect(card.userId).toBeUndefined()
    expect(card.sub).toBe('auth0|user_01M25BW24N47AXMGKW2X7GCZY0')
  })
})
