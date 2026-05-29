import { useT } from './i18n'

export function PendingReviewPage({
  contact,
  onLogout,
}: {
  contact?: string | null
  onLogout: () => void
}) {
  const t = useT()
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#0a1628',
        color: '#e8f0ff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          padding: 28,
          borderRadius: 12,
          border: '1px solid #2a4568',
          background: 'rgba(14, 27, 44, 0.95)',
        }}
      >
        <h1 style={{ margin: '0 0 12px', fontSize: 20 }}>{t('pending.title')}</h1>
        <p style={{ margin: '0 0 16px', lineHeight: 1.6, opacity: 0.9 }}>{t('pending.body')}</p>
        <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('pending.contactLabel')}</p>
        <p style={{ margin: '0 0 20px', opacity: 0.85 }}>
          {contact && String(contact).trim() ? contact : t('pending.contactEmpty')}
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onLogout}
            style={{
              padding: '10px 18px',
              borderRadius: 8,
              border: 0,
              fontWeight: 600,
              cursor: 'pointer',
              background: 'linear-gradient(90deg, #2b6cff, #5a9dff)',
              color: '#fff',
            }}
          >
            {t('btn.logout')}
          </button>
        </div>
      </div>
    </div>
  )
}
