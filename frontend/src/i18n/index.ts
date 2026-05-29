import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import zhJson from './zh.json'
import enJson from './en.json'
import thJson from './th.json'

export const LOCALES = ['zh', 'en', 'th'] as const
export type Locale = (typeof LOCALES)[number]

export type MessageBag = Record<string, string>

export const messages: Record<Locale, MessageBag> = {
  zh: zhJson as MessageBag,
  en: enJson as MessageBag,
  th: thJson as MessageBag,
}

/** 统一语言存储（兼容 daping_language / daping_locale） */
export const LS_LANGUAGE = 'lang'
export const LS_LANGUAGE_LEGACY = 'daping_language'
export const LS_LOCALE_LEGACY = 'daping_locale'
export const LS_TIME_RANGE = 'daping_time_range'
export const LS_CUSTOM_START = 'daping_custom_start'
export const LS_CUSTOM_END = 'daping_custom_end'

export type TimeRangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom'

const warnedMissing = new Set<string>()

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  let s = template
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{{${k}}}`).join(String(v))
  }
  return s
}

function warnMissing(key: string, locale: Locale) {
  if (!import.meta.env.DEV) return
  const id = `${locale}:${key}`
  if (warnedMissing.has(id)) return
  warnedMissing.add(id)
  console.warn('[i18n missing]', key)
}

/** 翻译：当前语言 → 英文回退（禁止回退中文） */
export function createT(locale: Locale) {
  const bag = messages[locale] ?? messages.en
  const fallbackEn = messages.en
  return (key: string, vars?: Record<string, string | number>): string => {
    let raw = bag[key]
    if (raw == null && locale !== 'en') {
      raw = fallbackEn[key]
      if (raw == null) warnMissing(key, locale)
    }
    if (raw == null) {
      warnMissing(key, locale)
      return key
    }
    return interpolate(raw, vars)
  }
}

export function normalizeLocale(v: unknown): Locale {
  const s = String(v || '').toLowerCase()
  if (s === 'en' || s === 'english') return 'en'
  if (s === 'th' || s === 'thai') return 'th'
  return 'zh'
}

export function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh'
  try {
    const u = new URLSearchParams(window.location.search).get('lang')
    if (u) return normalizeLocale(u)
  } catch {
    /* ignore */
  }
  try {
    const primary = localStorage.getItem(LS_LANGUAGE)
    if (primary) return normalizeLocale(primary)
    const legacy = localStorage.getItem(LS_LANGUAGE_LEGACY)
    if (legacy) return normalizeLocale(legacy)
    const legacy2 = localStorage.getItem(LS_LOCALE_LEGACY)
    if (legacy2) return normalizeLocale(legacy2)
  } catch {
    /* ignore */
  }
  return 'zh'
}

export function persistLocale(locale: Locale) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LS_LANGUAGE, locale)
  } catch {
    /* ignore */
  }
}

export function periodShort(locale: Locale, preset: TimeRangePreset): string {
  const tt = createT(locale)
  if (preset === 'today') return tt('period.today')
  if (preset === 'yesterday') return tt('period.yesterday')
  if (preset === 'last7') return tt('period.last7')
  if (preset === 'last30') return tt('period.last30')
  return tt('period.custom')
}

export function toYmdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function readInitialTimeRange(): { preset: TimeRangePreset; start: string; end: string } {
  const today = typeof window !== 'undefined' ? toYmdLocal(new Date()) : '2000-01-01'
  const fallback = { preset: 'today' as TimeRangePreset, start: today, end: today }
  if (typeof window === 'undefined') return fallback
  try {
    const p = localStorage.getItem(LS_TIME_RANGE)
    const preset: TimeRangePreset =
      p === 'yesterday' || p === 'last7' || p === 'last30' || p === 'custom' || p === 'today' ? p : 'today'
    const rs = localStorage.getItem(LS_CUSTOM_START)?.trim() || today
    const re = localStorage.getItem(LS_CUSTOM_END)?.trim() || today
    const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    return {
      preset,
      start: ymdOk(rs) ? rs : today,
      end: ymdOk(re) ? re : today,
    }
  } catch {
    return fallback
  }
}

export function roleI18nKey(role: string): string | null {
  const r = String(role || '').trim()
  if (r === 'super_admin' || r === 'tenant_owner') return 'role.super_admin'
  if (r === 'admin' || r === 'tenant_admin') return 'role.admin'
  if (r === 'viewer' || r === 'tenant_viewer') return 'role.viewer'
  return null
}

export function membershipStatusLabel(status: string, t: (k: string) => string): string {
  const s = String(status || '').toLowerCase()
  if (s === 'active') return t('status.active')
  if (s === 'disabled') return t('status.disabled')
  if (s === 'pending') return t('status.pending')
  return status
}

export function userStatusLabel(status: string, t: (k: string) => string): string {
  return membershipStatusLabel(status, t)
}

export function apiErrorMessage(code: string | undefined, status: number, t: ReturnType<typeof createT>): string {
  const c = String(code || '')
  const map: Record<string, string> = {
    forbidden: 'error.forbidden',
    username_taken: 'error.usernameTaken',
    invalid_username: 'error.invalidUsername',
    weak_password: 'error.invalidPassword',
    invalid_tenant_id: 'error.invalidTenant',
    tenant_not_found: 'error.tenantNotFound',
    invalid_role: 'error.invalidRole',
    invalid_status: 'error.invalidStatus',
    cannot_disable_self: 'error.cannotDisableSelf',
    cannot_delete_self: 'error.cannotDeleteSelf',
    cannot_delete_owner: 'error.cannotDeleteOwner',
    cannot_delete_super_admin: 'error.cannotDeleteSuperAdmin',
    cannot_delete_cqchic_primary_admin: 'error.cannotDeleteCqchicPrimary',
    cannot_delete_last_super_admin: 'error.cannotDeleteLastSuperAdmin',
    user_not_found: 'error.userNotFound',
    invalid_id: 'error.invalidId',
    not_found: 'error.notFound',
    database_unavailable: 'error.databaseUnavailable',
  }
  const key = map[c]
  if (key) return t(key)
  if (c) return t('error.generic', { code: c })
  return t('error.requestFailed', { status })
}

type I18nContextValue = {
  locale: Locale
  setLocale: (next: Locale) => void
  t: ReturnType<typeof createT>
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? readInitialLocale())
  const setLocale = useCallback((next: Locale) => {
    const loc = normalizeLocale(next)
    persistLocale(loc)
    setLocaleState(loc)
  }, [])
  const t = useMemo(() => createT(locale), [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

/** 组件内统一 t('module.key') */
export function useT() {
  return useI18n().t
}
