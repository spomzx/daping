import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from './apiClient'
import { getAuthHeaders } from './authStorage'
import { useT } from './i18n'

export function NotificationBell() {
  const t = useT()
  const nav = useNavigate()
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Array<{ id: number; title: string; is_read?: number }>>([])
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notifications', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      const j = (await res.json().catch(() => ({}))) as {
        unread_count?: number
        notifications?: Array<{ id: number; title: string; is_read?: number }>
      }
      if (!res.ok) return
      setUnread(Number(j.unread_count) || 0)
      const list = Array.isArray(j.notifications) ? j.notifications : []
      setPreview(list.slice(0, 5))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const el = wrapRef.current
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        className="war-header-btn"
        onClick={() => {
          setOpen((v) => !v)
          void load()
        }}
        style={{ position: 'relative' }}
      >
        {t('notifications.title')}
        {unread > 0 ? (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: '0 4px',
              borderRadius: 9,
              background: '#e74c3c',
              color: '#fff',
              fontSize: 11,
              lineHeight: '18px',
              textAlign: 'center',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '110%',
            width: 280,
            maxHeight: 320,
            overflow: 'auto',
            zIndex: 5000,
            background: '#0e1b2c',
            border: '1px solid #2a4568',
            borderRadius: 8,
            padding: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          {preview.length === 0 ? <div style={{ fontSize: 13, opacity: 0.75 }}>{t('notifications.empty')}</div> : null}
          {preview.map((n) => (
            <div key={n.id} style={{ fontSize: 13, padding: '8px 0', borderBottom: '1px solid #1a2d48', opacity: n.is_read ? 0.6 : 1 }}>
              {n.title}
            </div>
          ))}
          <button
            type="button"
            className="war-header-btn"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => {
              setOpen(false)
              nav('/notifications')
            }}
          >
            {t('notifications.viewAll')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
