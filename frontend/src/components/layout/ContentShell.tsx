import type { ReactNode } from 'react'

export function ContentShell({ children }: { children: ReactNode }) {
  return (
    <div className="content-shell">
      <div className="content-shell__surface">
        <div className="content-shell__inner">{children}</div>
      </div>
    </div>
  )
}
