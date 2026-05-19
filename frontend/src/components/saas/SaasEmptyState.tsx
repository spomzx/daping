export type SaasEmptyStateProps = {
  title?: string
  description?: string
  action?: React.ReactNode
}

export function SaasEmptyState({
  title = '暂无数据',
  description = '当前筛选条件下没有匹配的租户',
  action,
}: SaasEmptyStateProps) {
  return (
    <div className="saas-empty">
      <div className="saas-empty__icon" aria-hidden>
        ◇
      </div>
      <h3 className="saas-empty__title">{title}</h3>
      <p className="saas-empty__desc">{description}</p>
      {action}
    </div>
  )
}
