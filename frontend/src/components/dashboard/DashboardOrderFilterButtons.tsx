import { useI18n } from '../../i18n'
import {
  DASHBOARD_ORDER_FILTER_BUTTON_ORDER,
  DASHBOARD_ORDER_FILTER_I18N_KEYS,
} from '../../lib/dashboardFilterContract'
import type { DashboardOrderFilter } from '../../lib/dashboardFilters'

type Props = {
  value: DashboardOrderFilter
  onChange: (next: DashboardOrderFilter) => void
  className?: string
}

/** 大屏订单筛选按钮：顺序与默认高亮由 dashboardFilterContract 统一 */
export function DashboardOrderFilterButtons({ value, onChange, className = 'filter-buttons' }: Props) {
  const { t: tx } = useI18n()
  return (
    <div className={className}>
      {DASHBOARD_ORDER_FILTER_BUTTON_ORDER.map((key) => (
        <button
          key={key}
          type="button"
          className={value === key ? 'active' : ''}
          onClick={() => onChange(key)}
        >
          {tx(DASHBOARD_ORDER_FILTER_I18N_KEYS[key])}
        </button>
      ))}
    </div>
  )
}
