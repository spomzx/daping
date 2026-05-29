import type { ReactNode } from 'react'

export type AdminToolbarProps = {
  /** 左侧筛选区 */
  filters?: ReactNode
  /** 右侧操作区 */
  actions?: ReactNode
  /** 兼容：全部放在左侧 */
  children?: ReactNode
  className?: string
}

/** 筛选 / 操作工具条：左 filters、右 actions，自动换行 */
export function AdminToolbar({ filters, actions, children, className }: AdminToolbarProps) {
  if (children && !filters && !actions) {
    return (
      <div className={['admin-toolbar', 'admin-toolbar--split', className].filter(Boolean).join(' ')}>
        <div className="admin-toolbar__filters admin-filter-bar">{children}</div>
      </div>
    )
  }

  return (
    <div className={['admin-toolbar', 'admin-toolbar--split', className].filter(Boolean).join(' ')}>
      <div className="admin-toolbar__filters admin-filter-bar">{filters}</div>
      {actions ? <div className="admin-toolbar__actions">{actions}</div> : null}
    </div>
  )
}

export type AdminToolbarFieldProps = {
  label: ReactNode
  children: ReactNode
  className?: string
}

export function AdminToolbarField({ label, children, className }: AdminToolbarFieldProps) {
  return (
    <label className={['admin-toolbar__field', className].filter(Boolean).join(' ')}>
      <span className="admin-toolbar__label">{label}</span>
      {children}
    </label>
  )
}

export type AdminToolbarSearchProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function AdminToolbarSearch({ value, onChange, placeholder, className }: AdminToolbarSearchProps) {
  return (
    <input
      type="search"
      className={['admin-toolbar__search', 'locale-select', className].filter(Boolean).join(' ')}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
