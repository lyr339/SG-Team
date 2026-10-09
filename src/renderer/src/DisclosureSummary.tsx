import type { ComponentPropsWithoutRef, SVGProps } from 'react'
import { ChevronDownIcon } from './UiIcons'

/** One glyph for content disclosure: right when closed, down when open.
 * Native details state is read by CSS; no duplicate React state or click handler. */
export function DisclosureChevron({ open, className, ...props }: SVGProps<SVGSVGElement> & { open?: boolean }): React.JSX.Element {
  return <ChevronDownIcon {...props} className={`disclosure-chevron ${className ?? ''}`.trim()} data-open={open} />
}

export function DisclosureSummary({ children, className, chevronPosition = 'start', ...props }:
  ComponentPropsWithoutRef<'summary'> & { chevronPosition?: 'start' | 'end' }): React.JSX.Element {
  return <summary {...props} className={`disclosure-summary ${className ?? ''}`.trim()} data-chevron-position={chevronPosition}>
    {chevronPosition === 'start' ? <DisclosureChevron /> : null}
    <span className="disclosure-summary__content">{children}</span>
    {chevronPosition === 'end' ? <DisclosureChevron /> : null}
  </summary>
}
