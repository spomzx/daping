import type { ReactElement } from 'react'

const ICONS: Record<string, ReactElement> = {
  chart: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 14V8M10 14V4M16 14v-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  shop: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M3 8l2-4h10l2 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7 18v-5h6v5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  order: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M5 4h10v12H5z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 8h6M7 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="8" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 12h5l-1.5-1.5M14.5 8.5L16 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  sync: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M14 6a4.5 4.5 0 00-7.2-2.2M6 14a4.5 4.5 0 007.2 2.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M14 3v3h-3M6 17v-3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  job: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="4" y="4" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 8h6M7 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="8" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 16c0-2.5 1.8-4 4-4s4 1.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  tenant: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 16V6l6-3 6 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 16v-4h4v4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  log: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M6 4h8v12H6z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8h4M8 11h4M8 14h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5.05 5.05l1.06 1.06M13.9 13.9l1.06 1.06M5.05 14.95l1.06-1.06M13.9 6.1l1.06-1.06"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
  war: (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 14l4-8 4 5 4-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

export function SaasNavIcon({ name }: { name?: string }) {
  const icon = name ? ICONS[name] : ICONS.chart
  return <span className="saas-sidebar-icon">{icon ?? ICONS.chart}</span>
}
