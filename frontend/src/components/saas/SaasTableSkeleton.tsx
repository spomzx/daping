const COLS = [120, 80, 140, 140, 72, 100, 80, 100, 120]

export function SaasTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="saas-skeleton-table" aria-busy aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="saas-skeleton-row">
          {COLS.map((w, j) => (
            <div key={j} className="saas-skeleton-block" style={{ width: w, flexShrink: 0 }} />
          ))}
        </div>
      ))}
    </div>
  )
}
