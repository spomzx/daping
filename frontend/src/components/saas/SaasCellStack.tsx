/**
 * 列表单元格：主标题 + 副文案（统一 SaaS 双层展示）
 */
export function SaasCellStack({
  title,
  subtext,
  subtextPrefix,
  className = '',
}: {
  title: string
  subtext?: string | null
  /** 副文案前缀，如「账号」→ 显示为「账号：cqchic」 */
  subtextPrefix?: string
  className?: string
}) {
  const sub =
    subtext != null && String(subtext).trim() !== ''
      ? subtextPrefix
        ? `${subtextPrefix}：${subtext}`
        : String(subtext)
      : null

  return (
    <div className={`saas-cell-stack ${className}`.trim()}>
      <div className="saas-cell-stack__title">{title}</div>
      {sub ? <div className="saas-cell-stack__sub">{sub}</div> : null}
    </div>
  )
}
