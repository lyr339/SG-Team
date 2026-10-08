import { useState } from 'react'
import {
  applyAppearancePreferences,
  readAppearancePreferences,
} from '../appearance-preferences'
import { SettingsNotice } from '../settings/SettingsNotice'
import { FeedbackLine } from '../feedback/FeedbackLine'
import { NotificationCard } from '../notifications/NotificationCard'
import './feedback-review.css'
/** Presentation fixtures only. No credentials, workflows, source receipts or
 * system delivery are executed by this page. Same components as the app. */
export function FeedbackReview(): React.JSX.Element {
  const [success, showSuccess] = useState(true),
    [card, showCard] = useState(true),
    [update, showUpdate] = useState(true),
    [actionResult, showActionResult] = useState(true)
  return (
    <main className="feedback-review">
      <header>
        <h1>拾光 · 通知与提示</h1>
        <p>真实组件样式走查 · 以下全部为设计假数据，不执行任何业务操作。</p>
        <div className="feedback-review__themes">
          <button
            className="secondary-button"
            onClick={() =>
              applyAppearancePreferences({
                ...readAppearancePreferences(),
                colorMode: 'light',
              })
            }
          >
            浅色
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              applyAppearancePreferences({
                ...readAppearancePreferences(),
                colorMode: 'dark',
              })
            }
          >
            深色
          </button>
        </div>
      </header>
      <div className="feedback-review__grid">
        <section className="feedback-review__wide">
          <h2>更新结果 · 关闭与长文案</h2>
          {update ? (
            <FeedbackLine tone="success" onDismiss={() => showUpdate(false)}>
              示例 · 已更新到 0.5.22。Cursor 里的 SG Team 服务器会随之重载一次；若席位长时间未恢复，到 Cursor 的 MCP 设置里刷新 SG Team。
            </FeedbackLine>
          ) : <button type="button" className="secondary-button" onClick={() => showUpdate(true)}>重新展示更新提示</button>}
        </section>
        <section>
          <h2>操作结果</h2>
          {success ? (
            <SettingsNotice
              message={{
                tone: 'success',
                title: '示例 · 账号切换已完成',
                detail:
                  '示例：当前结果已保存。展开查看完整说明，不会重新运行任何步骤。',
              }}
              onDismiss={() => showSuccess(false)}
            />
          ) : (
            <button
              className="secondary-button"
              onClick={() => showSuccess(true)}
            >
              重新展示成功提示
            </button>
          )}
          <SettingsNotice
            message={{
              tone: 'warning',
              title: '示例 · 处理已完成，后续步骤仍需核对',
              detail:
                '示例：已完成部分保持有效。请核对未完成步骤，不要重复执行已经完成的操作。长标题按首行对齐图标与动作，完整原因默认展开。',
            }}
          />
          <SettingsNotice
            message={{
              tone: 'error',
              title: '示例 · 本次读取未完成',
              detail:
                '示例：连接暂不可用，原有记录与输入仍保留。恢复连接后可手动重试；不会自动重复执行。',
            }}
          />
        </section>
        <section>
          <h2>页内说明与进行中</h2>
          <FeedbackLine>
            示例：来源内容暂未准备好，通知记录仍保留。
          </FeedbackLine>
          <FeedbackLine tone="working">
            示例进行中状态：正在读取结果，请稍候。
          </FeedbackLine>
          <FeedbackLine
            tone="warning"
            action={<button className="secondary-button">示例查看详情</button>}
          >
            示例：部分步骤待确认。此动作不会触发业务执行。
          </FeedbackLine>
          <FeedbackLine tone="error">
            示例：发送未完成。完整说明不挤在模型栏旁，用户仍可查看和保留输入。
          </FeedbackLine>
          {actionResult ? (
            <FeedbackLine tone="warning" onDismiss={() => showActionResult(false)}
              action={<button type="button" className="secondary-button">示例查看完整结果，不重新运行操作</button>}>
              示例 · 长说明可以自然换行，关闭按钮始终在第一行右侧。额外操作位于正文下方，不挤占正文，也不覆盖关闭按钮。
            </FeedbackLine>
          ) : <button type="button" className="secondary-button" onClick={() => showActionResult(true)}>重新展示带操作提示</button>}
        </section>
        <section>
          <h2>低打扰提醒卡</h2>
          {card ? (
            <NotificationCard
              title="示例 · 重要结果已保存"
              source="设计假数据 · 非实际业务结果"
              detail="标题、来源、摘要与动作按阅读顺序排列。不用彩色左边框，也不抢输入焦点。"
              tone="success"
              onDismiss={() => showCard(false)}
              actions={<button>示例查看结果</button>}
            />
          ) : (
            <button className="secondary-button" onClick={() => showCard(true)}>
              重新展示提醒卡
            </button>
          )}
        </section>
      </div>
    </main>
  )
}
