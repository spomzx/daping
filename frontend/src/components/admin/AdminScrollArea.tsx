import type { CSSProperties, ReactNode } from 'react'

export type AdminScrollAreaProps = {
  children: ReactNode
  className?: string
  /** 最大高度，超出后纵向滚动 */
  maxHeight?: number | string
  /** 是否允许横向滚动 */
  horizontal?: boolean
  style?: CSSProperties
}

/** 统一滚动容器：section / table / card 内滚动 */
export function AdminScrollArea({
  children,
  className,
  maxHeight,
  horizontal = true,
  style,
}: AdminScrollAreaProps) {
  const mergedStyle: CSSProperties = {
    ...style,
    ...(maxHeight != null ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight } : {}),
  }

  return (
    <div
      className={[
        'admin-scroll-area',
        horizontal ? 'admin-scroll-area--x' : 'admin-scroll-area--x-off',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={mergedStyle}
    >
      {children}
    </div>
  )
}
