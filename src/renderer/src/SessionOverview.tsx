import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SunIcon } from './UiIcons'

interface SessionOverviewProps {
  snapshot: DesktopSnapshot
  onCreateIndependentSessions: () => void
}

export function SessionOverview({
  snapshot,
  onCreateIndependentSessions
}: SessionOverviewProps): React.JSX.Element {
  return (
    <div className="overview-page">
      <header className="v2-module-header">
        <div>
          <h1>Cursor 会话</h1>
          <p>从左侧选择会话，直接进入工作区</p>
        </div>
      </header>

      <div className="overview-page__scroll">
        <div className="fresh-empty">
          <span className="fresh-empty__sun"><SunIcon /></span>
          {snapshot.sessions.length ? (
            <>
              <h2>正在打开可用会话…</h2>
              <p>也可以直接点击左侧任一体征卡。</p>
            </>
          ) : (
            <>
              <h2>还没有发现 Cursor 会话</h2>
              <p>在「运行」页批量创建会话；席位就绪后会自动出现在这里，需要协作时再在名册里把它们编成组。</p>
              <div className="fresh-empty__actions">
                <button onClick={onCreateIndependentSessions}>批量创建独立会话</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
