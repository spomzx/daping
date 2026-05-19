/** /shops 验收：在浏览器 Console 输出真实 computed style（F12 可见） */
export function logShopsScrollDiagnostics(): void {
  const run = () => {
    const scrollEl = document.querySelector('.shops-table-scroll')
    const wrapEl = document.querySelector('.shop-mgmt-table-wrap')
    const mainEl = document.querySelector('.dashboard-main')
    const cs = scrollEl ? getComputedStyle(scrollEl) : null
    const csWrap = wrapEl ? getComputedStyle(wrapEl) : null
    const csMain = mainEl ? getComputedStyle(mainEl) : null
    const payload = {
      documentElement_className: document.documentElement.className,
      body_scrollHeight: document.body.scrollHeight,
      window_innerHeight: window.innerHeight,
      scrollHeight_gt_viewport: document.body.scrollHeight > window.innerHeight,
      shops_table_scroll_rect: scrollEl?.getBoundingClientRect(),
      shops_table_scroll_overflowY: cs?.overflowY ?? null,
      shops_table_scroll_maxHeight: cs?.maxHeight ?? null,
      shops_table_scroll_height: cs?.height ?? null,
      shop_mgmt_table_wrap_overflowY: csWrap?.overflowY ?? null,
      dashboard_main_overflowY: csMain?.overflowY ?? null,
      dashboard_main_flex: csMain?.flex ?? null,
      dashboard_main_minHeight: csMain?.minHeight ?? null,
    }
    console.log('[shops-scroll-evidence]', payload)
    return payload
  }
  run()
  window.setTimeout(run, 800)
  window.setTimeout(run, 2000)
}
