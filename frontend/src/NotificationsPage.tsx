import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './apiClient'
import { getAuthHeaders } from './authStorage'
import { useT } from './i18n'

type Row = {
  id: number
  title: string
  content?: string | null
  type?: string
  is_read?: number
  created_at?: string
}

export function NotificationsPage({ onBack }: { onBack: () => void }) {
  const t = useT()
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const res = await apiFetch('/api/notifications', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      const j = (await res.json().catch(() => ({}))) as { notifications?: Row[]; error?: string }
      if (!res.ok) {
        setRows([])
        setErr(String(j.error || t('notifications.loadFailed', { status: res.status })))
        return
      }
      setRows(Array.isArray(j.notifications) ? j.notifications : [])
    } catch {
      setRows([])
      setErr(t('error.network'))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  async function markRead(id: number) {
    try {
      await apiFetch(`/api/notifications/${id}/read`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders() },
      })
      void load()
    } catch {
      /* ignore */
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a1628', color: '#e8f0ff', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <button type="button" onClick={onBack} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #355a88', background: 'transparent', color: '#cfe6ff', cursor: 'pointer' }}>
            ← {t('btn.backDashboard')}
          </button>
          <h1 style={{ margin: 0, fontSize: 20 }}>{t('notifications.title')}</h1>
          <button type="button" onClick={() => void load()} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #355a88', background: 'transparent', color: '#cfe6ff', cursor: 'pointer' }}>
            {t('btn.refresh')}
          </button>
        </div>
        {err ? <div style={{ color: '#ffaa88', marginBottom: 12 }}>{err}</div> : null}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.length === 0 && !err ? <li style={{ opacity: 0.7 }}>{t('notifications.empty')}</li> : null}
          {rows.map((r) => (
            <li
              key={r.id}
              style={{
                padding: 14,
                marginBottom: 10,
                borderRadius: 8,
                border: '1px solid #1f3555',
                background: 'rgba(14, 27, 44, 0.85)',
                opacity: r.is_read ? 0.65 : 1,
              }}
            >
              <div style={{ fontWeight: 600 }}>{r.title}</div>
              {r.content ? (
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9, whiteSpace: 'pre-wrap' }}>{r.content}</div>
              ) : null}
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }}>{r.created_at ? String(r.created_at) : ''}</div>
              {!r.is_read ? (
                <button
                  type="button"
                  onClick={() => void markRead(r.id)}
                  style={{ marginTop: 10, padding: '6px 12px', borderRadius: 6, border: '1px solid #2b6cff', background: 'transparent', color: '#8ec5ff', cursor: 'pointer', fontSize: 12 }}
                >
                  {t('notifications.markRead')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
