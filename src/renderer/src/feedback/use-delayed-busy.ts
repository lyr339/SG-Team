import { useEffect, useState } from 'react'

/** Delay only visual feedback, never the operation. Fast local saves need no loading flash. */
export function useDelayedBusy(busy: boolean, delay = 180): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!busy) { setVisible(false); return }
    const timer = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(timer)
  }, [busy, delay])
  return busy && visible
}
