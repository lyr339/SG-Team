import { useLayoutEffect, useState } from 'react'
import { AppearanceSettings } from '../AppearanceSettings'
import { applyAppearancePreferences, DEFAULT_APPEARANCE_PREFERENCES, type AppearancePreferences } from '../appearance-preferences'
import { FeedbackLine } from '../feedback/FeedbackLine'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { MessageContent } from '../MessageContent'
import { NotificationCard } from '../notifications/NotificationCard'
import { SettingsNotice } from '../settings/SettingsNotice'
import './theme-review.css'

const message = '# 阅读与对照\n\n普通文字、**强调内容**和 `inline_code` 应始终可辨认。\n\n| 类型 | 说明 |\n| --- | --- |\n| 主题 | 只改变界面角色 |\n| 状态 | 保留原有语义 |\n| 代码 | `table_code` |\n\n```ts\nconst preserved = true;\nreturn preserved;\n```\n\n> 完整说明保留，不重新运行操作。'

/** Only real presentation components and in-memory controls. This fixture never
 * sends IPC, changes saved preferences, executes actions or requests a model. */
export function ThemeReview(): React.JSX.Element {
  const [appearance, setAppearance] = useState<AppearancePreferences>({ ...DEFAULT_APPEARANCE_PREFERENCES, colorMode: 'light' })
  const [checked, setChecked] = useState(true)
  useLayoutEffect(() => { applyAppearancePreferences(appearance) }, [appearance])
  const patch = (value: Partial<AppearancePreferences>) => setAppearance(current => ({ ...current, ...value }))
  return <main className="theme-review">
    <header><h1>主题 · 真实组件状态</h1><p>仅走查呈现；不会运行任何账号、自动化或模型请求。</p></header>
    <div className="theme-review__layout">
      <AppearanceSettings {...appearance} onAccentChange={accent => patch({ accent })} onBackgroundChange={background => patch({ background })}
        onCardOpacityChange={cardOpacity => patch({ cardOpacity })} onColorModeChange={colorMode => patch({ colorMode })} onClose={() => {}} />
      <div className="theme-review__samples">
        <section className="theme-review__card" aria-label="控件状态样本">
          <h2>控件 · 交互与不可用状态</h2>
          <div className="theme-review__actions"><button type="button" className="primary-button">主操作</button><button type="button" className="primary-button" disabled>不可用</button>
            <button type="button" className="primary-button" aria-busy="true">保存中…</button><button type="button" className="run-sheet__confirm is-danger">危险操作</button></div>
          <div className="theme-review__actions"><div className="composer-submit"><button type="button">发送</button></div><div className="account-browser__key-input"><button type="button">保存</button></div>
            <button type="button" className="storage-cleanup__button is-primary">安全操作</button><button type="button" className="app-update__button is-primary">轻量主操作</button></div>
          <div className="theme-review__actions"><ToggleSwitch checked={checked} label="可用开关" onChange={setChecked} />
            <ToggleSwitch checked={false} label="关闭开关" onChange={() => {}} /><ToggleSwitch checked label="禁用开关" disabled onChange={() => {}} />
            <ToggleSwitch checked label="保存中开关" busy onChange={() => {}} /></div>
          <div className="theme-review__actions"><input className="app-update__feed-input" aria-label="文字输入示例" defaultValue="保留的输入内容" />
            <select aria-label="原生下拉示例" defaultValue="one"><option value="one">保持语义与键盘行为</option><option value="two">另一选项</option></select></div>
        </section>
        <section className="theme-review__card" aria-label="消息内容样本"><h2>消息 · 普通面与主题面</h2>
          <div className="chat-row--mine"><div className="chat-bubble"><MessageContent text={message} /></div></div>
          <div className="chat-bubble"><MessageContent text={message} /></div>
        </section>
        <section aria-label="提示通知样本"><h2>提示 · 固定语义色</h2><FeedbackLine tone="error">失败仍用错误语义，不随主题变色。</FeedbackLine>
          <SettingsNotice message={{ tone: 'success', title: '结果已保存', detail: '这里只渲染组件，不执行任何业务。' }} onDismiss={() => {}} />
          <NotificationCard title="待确认结果" source="隔离样本" detail="主题变化不改变通知类别、读取或关闭语义。" tone="warning" onDismiss={() => {}}
            actions={<button type="button">查看详情</button>} />
        </section>
      </div>
    </div>
  </main>
}
