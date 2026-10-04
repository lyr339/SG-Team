import type { GroupCommunicationSummary } from './collaboration-map-view'

export function CollaborationMapIcon(): React.JSX.Element {
  return <svg viewBox="0 0 22 18" aria-hidden="true"><path d="M2 14C7 14 6 4 13 4H19M15.5 1.5 19 4l-3.5 2.5M2 4C6 4 6 14 13 14H19M15.5 11.5 19 14l-3.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

interface Props { groupName: string; members: number; summary?: GroupCommunicationSummary; onOpen: () => void }
export function GroupCollaborationEntry({ groupName, members, summary, onOpen }: Props): React.JSX.Element {
  return <button type="button" className="collaboration-entry" aria-haspopup="dialog" aria-label={`查看「${groupName}」的协作图`} onClick={onOpen}>
    <span className="collaboration-entry__icon"><CollaborationMapIcon /></span>
    <span className="collaboration-entry__copy"><strong>协作图</strong><small>
      {members} 位成员{summary?.pending ? ` · ${summary.pending} 条待回应` : summary?.count ? ` · ${summary.count} 条记录` : ' · 查看组内收发关系'}
    </small></span>
    <svg className="collaboration-entry__open" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 12 12 4M5 4h7v7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
}
