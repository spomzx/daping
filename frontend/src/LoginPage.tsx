import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AUTH_TOKEN_KEY, clearLastUsername, readLastUsername, saveLastUsername } from './authStorage'
import { fetchAuthMe, postAuthLogin } from './apiClient'
import { parseAuthMeJson, type AuthSession } from './authRole'
import { useT } from './i18n'
import { PasswordInput } from './components/PasswordInput'

export type { AuthSession } from './authRole'

export function LoginPage({ onLoginSuccess }: { onLoginSuccess?: (s: AuthSession) => void }) {
  const t = useT()
  const nav = useNavigate()
  const [username, setUsername] = useState(readLastUsername)
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  function onUsernameChange(value: string) {
    setUsername(value)
    if (!value.trim()) clearLastUsername()
  }

  function onClearRememberedUsername() {
    setUsername('')
    clearLastUsername()
  }

  const canClearRemembered = Boolean(username.trim() || readLastUsername())

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      const r = await postAuthLogin({ username, password })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(String((j as { error?: string }).error || t('error.loginFailed')))
        return
      }
      const token = (j as { token?: string }).token
      if (!token) {
        setErr(t('error.tokenMissing'))
        return
      }
      localStorage.setItem(AUTH_TOKEN_KEY, token)

      let meJson: unknown
      try {
        const mr = await fetchAuthMe()
        if (!mr.ok) {
          localStorage.removeItem(AUTH_TOKEN_KEY)
          setErr(mr.status === 401 || mr.status === 403 ? t('error.sessionInvalid') : t('error.verifyFailed', { status: mr.status }))
          return
        }
        meJson = await mr.json()
      } catch (meErr) {
        localStorage.removeItem(AUTH_TOKEN_KEY)
        const name = (meErr as Error)?.name
        setErr(name === 'AbortError' ? t('error.verifyTimeout') : t('error.verifyState'))
        return
      }

      const sess = parseAuthMeJson(meJson)
      if (!sess) {
        localStorage.removeItem(AUTH_TOKEN_KEY)
        setErr(t('error.userInfoInvalid'))
        return
      }

      saveLastUsername(username)

      if (onLoginSuccess) {
        onLoginSuccess(sess)
      }
      nav(sess.access === 'pending_review' ? '/pending-review' : '/legacy', { replace: true })
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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #0a1628 0%, #0e1b2c 40%, #13263d 100%)',
        color: '#e8f0ff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 'min(400px, 92vw)',
          padding: 28,
          borderRadius: 14,
          border: '1px solid #1f3555',
          background: 'rgba(14, 27, 44, 0.95)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>{t('login.title')}</h1>
        <p style={{ margin: '0 0 20px', opacity: 0.75, fontSize: 13 }}>{t('login.subtitle')}</p>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 6,
              fontSize: 13,
            }}
          >
            <span>{t('login.username')}</span>
            {canClearRemembered ? (
              <button
                type="button"
                onClick={onClearRememberedUsername}
                style={{
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: '#7ab4ff',
                  fontSize: 12,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {t('login.clearRememberedUsername')}
              </button>
            ) : null}
          </span>
          <input
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            autoComplete="username"
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #2a4568', background: '#0b1524', color: '#fff' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>{t('login.password')}</span>
          <PasswordInput
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={{ padding: 10, borderRadius: 8, border: '1px solid #2a4568', background: '#0b1524', color: '#fff' }}
          />
        </label>
        {err ? <div style={{ color: '#ff8a8a', marginBottom: 12, fontSize: 14 }}>{err}</div> : null}
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
          {loading ? t('btn.loggingIn') : t('btn.login')}
        </button>
        <p style={{ marginTop: 18, textAlign: 'center', fontSize: 14 }}>
          <Link to="/register" style={{ color: '#7ab4ff' }}>
            {t('login.registerLink')}
          </Link>
        </p>
      </form>
    </div>
  )
}
