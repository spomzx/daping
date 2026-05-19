import { useState, type CSSProperties, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { registerPublicAccount } from './apiClient'
import { REGISTER_PENDING_CONTACT_KEY } from './authRoutes'
import { useT } from './i18n'
import { PasswordInput } from './components/PasswordInput'

const inp: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #2a4568',
  background: '#0b1524',
  color: '#e8f0ff',
  boxSizing: 'border-box',
}

export function RegisterPage() {
  const t = useT()
  const nav = useNavigate()
  const [tenantName, setTenantName] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [contact, setContact] = useState('')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setOk('')
    setLoading(true)
    try {
      const res = await registerPublicAccount({
        tenant_name: tenantName.trim(),
        username: username.trim(),
        display_name: displayName.trim() || undefined,
        password,
        confirm_password: confirm,
        contact: contact.trim() || undefined,
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setErr(String(j.error || t('register.failed', { status: res.status })))
        return
      }
      setOk(t('register.success'))
      try {
        const c = contact.trim()
        if (c) sessionStorage.setItem(REGISTER_PENDING_CONTACT_KEY, c)
        else sessionStorage.removeItem(REGISTER_PENDING_CONTACT_KEY)
      } catch {
        /* ignore */
      }
      window.setTimeout(() => nav('/pending-review', { replace: true }), 1500)
    } catch {
      setErr(t('error.network'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 24,
        background: 'linear-gradient(160deg, #0a1628 0%, #0e1b2c 40%, #13263d 100%)',
        color: '#e8f0ff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        <p style={{ marginBottom: 16 }}>
          <Link to="/login" style={{ color: '#7ab4ff' }}>
            {t('register.backLogin')}
          </Link>
        </p>
        <form
          onSubmit={onSubmit}
          style={{
            padding: 24,
            borderRadius: 14,
            border: '1px solid #1f3555',
            background: 'rgba(14, 27, 44, 0.95)',
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 20 }}>{t('register.title')}</h1>
          <p style={{ margin: '0 0 18px', opacity: 0.75, fontSize: 13 }}>{t('register.subtitle')}</p>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.tenantName')} <span style={{ color: '#ff9e9e' }}>*</span>
            <input style={{ ...inp, marginTop: 6 }} value={tenantName} onChange={(e) => setTenantName(e.target.value)} />
          </label>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.username')} <span style={{ color: '#ff9e9e' }}>*</span>
            <input style={{ ...inp, marginTop: 6 }} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.displayName')}
            <input style={{ ...inp, marginTop: 6 }} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.password')} <span style={{ color: '#ff9e9e' }}>*</span>
            <PasswordInput
              name="password"
              style={{ ...inp, marginTop: 6 }}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.confirmPassword')} <span style={{ color: '#ff9e9e' }}>*</span>
            <PasswordInput
              name="confirm_password"
              style={{ ...inp, marginTop: 6 }}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
            {t('register.contactOptional')}
            <input style={{ ...inp, marginTop: 6 }} value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t('register.contactPlaceholder')} />
          </label>
          {err ? <div style={{ color: '#ff8a8a', marginBottom: 12, fontSize: 14 }}>{err}</div> : null}
          {ok ? <div style={{ color: '#7dffb3', marginBottom: 12, fontSize: 14 }}>{ok}</div> : null}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 8,
              border: 0,
              fontWeight: 700,
              cursor: loading ? 'wait' : 'pointer',
              background: 'linear-gradient(90deg, #2b6cff, #5a9dff)',
              color: '#fff',
            }}
          >
            {loading ? t('btn.submitting') : t('register.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
