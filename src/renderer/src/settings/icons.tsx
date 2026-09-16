interface IconProps {
  className?: string
}

function Icon({ className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

/** 设置页导航图标：与 UiIcons 同一笔画语言（24 视窗、圆角端点、currentColor）。 */

export function SettingsAccountsIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><circle cx="12" cy="8.5" r="3.6" {...stroke} /><path d="M4.8 19.5c.9-3.6 3.7-5.5 7.2-5.5s6.3 1.9 7.2 5.5" {...stroke} /></Icon>
}

export function SettingsImportIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M12 4v9.5M8 9.5l4 4 4-4" {...stroke} /><path d="M4.5 15v2.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7V15" {...stroke} /></Icon>
}

export function SettingsAutomationIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M13 3.5 5.5 13.5H11l-1 7 7.5-10H12l1-7Z" {...stroke} /></Icon>
}

export function SettingsAozaiIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><rect x="3.5" y="6" width="17" height="12" rx="2.2" {...stroke} /><path d="M3.5 10h17M7 14.5h4" {...stroke} /></Icon>
}

export function SettingsMaintenanceIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="m14.8 6.2 3 3M4.5 19.5l1.2-4.2L14.9 6a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7l-9.2 9.2-4.2 1.3Z" {...stroke} /></Icon>
}

/** 统计：基线上三根节奏柱，与其余导航图标同一笔画语言。 */
export function SettingsStatsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.5 19.5h15" {...stroke} />
      <path d="M7.5 16.2v-4.4M12 16.2V6.8M16.5 16.2v-6.9" {...stroke} />
    </Icon>
  )
}

/** 软件更新：托盘上方一支向上的箭头（与「导入来源」的向下箭头成对）。 */
export function SettingsUpdateIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 14.5V4.8M8 8.8l4-4 4 4" {...stroke} />
      <path d="M4.5 15v2.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7V15" {...stroke} />
    </Icon>
  )
}

/** 存储清理：带盖整理箱（两道格线），与「维护」的扳手同一笔画语言。 */
export function SettingsCleanupIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 8.5h14M6.2 8.5 7 18.2a1.6 1.6 0 0 0 1.6 1.5h6.8a1.6 1.6 0 0 0 1.6-1.5l.8-9.7" {...stroke} />
      <path d="M9.5 8.5V6.3A1.8 1.8 0 0 1 11.3 4.5h1.4a1.8 1.8 0 0 1 1.8 1.8v2.2M10 12.5v4M14 12.5v4" {...stroke} />
    </Icon>
  )
}
