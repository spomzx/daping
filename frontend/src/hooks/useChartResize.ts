import { useEffect, useState, type RefObject } from 'react'

/** 监听容器尺寸变化，供 Recharts / ECharts 在 flex 布局下重新计算宽高 */
export function useChartResize(ref: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const apply = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    }

    apply()
    const ro = new ResizeObserver(() => apply())
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, ...deps])

  return size
}
