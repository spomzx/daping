export type SaasQuotaProgressProps = {
  current: number
  limit: number
  unit: string
}

function progressLevel(pct: number): 'normal' | 'warn' | 'danger' {
  if (pct > 100) return 'danger'
  if (pct > 80) return 'warn'
  return 'normal'
}

export function SaasQuotaProgress({ current, limit, unit }: SaasQuotaProgressProps) {
  const safeLimit = limit > 0 ? limit : 1
  const pct = (current / safeLimit) * 100
  const level = progressLevel(pct)
  const width = Math.min(Math.max(pct, 0), 100)

  const fillClass =
    level === 'normal' ? 'saas-progress__fill' : `saas-progress__fill saas-progress__fill--${level}`

  return (
    <div className="saas-quota">
      <div className="saas-progress" aria-hidden>
        <div className={fillClass} style={{ width: `${width}%` }} />
      </div>
      <span className="saas-quota__text">
        {current} / {limit} {unit}
      </span>
    </div>
  )
}
