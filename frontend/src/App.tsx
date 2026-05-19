import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AnalyticsPage } from './AnalyticsPage'
import { LoginPage } from './LoginPage'
import {
  parseAuthMeJson,
  isAdminLike,
  isViewerLike,
  isSuperAdmin,
  isPlatformScope,
  type AuthSession,
} from './authRole'
import { ShopMgmtPage } from './ShopMgmtPage'
import { UserMgmtPage } from './UserMgmtPage'
import { TenantsPage } from './admin/pages/TenantsPage'
import { PlatformViewTenantProvider } from './context/PlatformViewTenantContext'
import { isPublicRoute, REGISTER_PENDING_CONTACT_KEY } from './authRoutes'
import { fetchAuthMe, postAuthLogout } from './apiClient'
import { AUTH_TOKEN_KEY } from './authStorage'
import { useI18n } from './i18n'
import { RegisterPage } from './RegisterPage'
import { PendingReviewPage } from './PendingReviewPage'
import { NotificationsPage } from './NotificationsPage'
import { AdminLayout } from './admin/AdminLayout'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { SyncCenterPage } from './pages/SyncCenter/SyncCenterPage'
import { OrdersPage } from './pages/Orders/OrdersPage'
import { AuthorizationsPage } from './pages/Authorizations/AuthorizationsPage'
import { LegacyDashboardPage } from './legacy/LegacyDashboardPage'

const WAR_ROOM_HOME = '/legacy'
const SAAS_CONSOLE_HOME = '/dashboard'

function AppShell() {
  const { t: tx } = useI18n()
  const loc = useLocation()
  const nav = useNavigate()
  const [session, setSession] = useState<AuthSession | null>(null)
  const sessionRef = useRef<AuthSession | null>(null)
  sessionRef.current = session

  /** 无 token 时无需异步校验；有 token 时 me 完成后为 true（避免 /me 循环） */
  const [isAuthChecked, setIsAuthChecked] = useState(() => {
    if (typeof window === 'undefined') return true
    return !localStorage.getItem(AUTH_TOKEN_KEY)
  })

  const authRunGen = useRef(0)

  useEffect(() => {
    const path = loc.pathname
    const token = localStorage.getItem(AUTH_TOKEN_KEY)
    const gen = ++authRunGen.current
    const pathIsPublic = isPublicRoute(path)

    if (path !== '/login' && sessionRef.current) {
      setIsAuthChecked(true)
      return
    }

    if (path === '/login') {
      if (!token) {
        setSession(null)
        setIsAuthChecked(true)
        return
      }
      let cancelled = false
      ;(async () => {
        try {
          const r = await fetchAuthMe()
          if (cancelled || gen !== authRunGen.current) return
          if (!r.ok) throw new Error('me_bad_status')
          const j = await r.json()
          const sess = parseAuthMeJson(j)
          if (!sess) throw new Error('me_bad_payload')
          if (cancelled || gen !== authRunGen.current) return
          setSession(sess)
          setIsAuthChecked(true)
          nav(sess.access === 'pending_review' ? '/pending-review' : WAR_ROOM_HOME, { replace: true })
        } catch {
          if (cancelled || gen !== authRunGen.current) return
          localStorage.removeItem(AUTH_TOKEN_KEY)
          setSession(null)
          setIsAuthChecked(true)
        }
      })()
      return () => {
        cancelled = true
      }
    }

    if (!token) {
      setSession(null)
      setIsAuthChecked(true)
      if (!pathIsPublic) {
        nav('/login', { replace: true })
      }
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const r = await fetchAuthMe()
        if (cancelled || gen !== authRunGen.current) return
        if (!r.ok) throw new Error('me_bad')
        const j = await r.json()
        const sess = parseAuthMeJson(j)
        if (!sess) throw new Error('me_bad')
        if (cancelled || gen !== authRunGen.current) return
        setSession(sess)
        setIsAuthChecked(true)
        if (sess.access === 'pending_review' && path !== '/pending-review') {
          nav('/pending-review', { replace: true })
        }
      } catch {
        if (cancelled || gen !== authRunGen.current) return
        localStorage.removeItem(AUTH_TOKEN_KEY)
        setSession(null)
        setIsAuthChecked(true)
        if (!pathIsPublic) {
          nav('/login', { replace: true })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loc.pathname, nav])

  const handleLoginSuccess = useCallback((s: AuthSession) => {
    setSession(s)
    setIsAuthChecked(true)
  }, [])

  function doLogout() {
    const t = localStorage.getItem(AUTH_TOKEN_KEY)
    void postAuthLogout(t).catch(() => null)
    localStorage.removeItem(AUTH_TOKEN_KEY)
    setSession(null)
    setIsAuthChecked(true)
    nav('/login', { replace: true })
  }

  if (loc.pathname === '/register') {
    return <RegisterPage />
  }

  if (loc.pathname === '/login') {
    const token = localStorage.getItem(AUTH_TOKEN_KEY)
    if (token && !isAuthChecked) {
      return (
        <div className="loading" style={{ padding: 24 }}>
          {tx('auth.verifyingLogin')}
        </div>
      )
    }
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  if (loc.pathname === '/pending-review' && !session) {
    let pendingContact: string | null = null
    try {
      const c = sessionStorage.getItem(REGISTER_PENDING_CONTACT_KEY)
      pendingContact = c && c.trim() ? c : null
    } catch {
      /* ignore */
    }
    return (
      <PendingReviewPage
        contact={pendingContact}
        onLogout={() => {
          try {
            sessionStorage.removeItem(REGISTER_PENDING_CONTACT_KEY)
          } catch {
            /* ignore */
          }
          nav('/login', { replace: true })
        }}
      />
    )
  }

  if (!isAuthChecked) {
    return (
      <div className="loading" style={{ padding: 24 }}>
        {tx('auth.verifyingLogin')}
      </div>
    )
  }

  if (!session) {
    if (isPublicRoute(loc.pathname)) {
      return null
    }
    return <Navigate to="/login" replace />
  }

  if (session.access === 'pending_review') {
    if (loc.pathname !== '/pending-review') {
      return <Navigate to="/pending-review" replace />
    }
    return <PendingReviewPage contact={session.contact} onLogout={doLogout} />
  }

  if (loc.pathname === '/pending-review') {
    return <Navigate to={WAR_ROOM_HOME} replace />
  }

  if (loc.pathname === '/' || loc.pathname === '/analytics') {
    return <Navigate to={WAR_ROOM_HOME} replace />
  }

  const authed = session

  function saasWrap(titleKey: string, node: ReactNode) {
    return (
      <AdminLayout
        appRole={authed.role}
        appUserScope={authed.scope}
        appUsername={authed.username}
        appAccess={authed.access}
        onLogout={doLogout}
        titleKey={titleKey}
      >
        {node}
      </AdminLayout>
    )
  }

  function withPlatformView(node: ReactNode) {
    if (isPlatformScope({ scope: authed.scope, role: authed.role })) {
      return <PlatformViewTenantProvider>{node}</PlatformViewTenantProvider>
    }
    return node
  }

  if (loc.pathname === '/legacy') {
    return withPlatformView(
      <LegacyDashboardPage
        appRole={session.role}
        appUserScope={session.scope}
        appUsername={session.username}
        appAccess={session.access}
        onLogout={doLogout}
      />,
    )
  }

  if (loc.pathname === '/notifications') {
    if (!isSuperAdmin(session.role)) {
      return <Navigate to={SAAS_CONSOLE_HOME} replace />
    }
    return <NotificationsPage onBack={() => nav(SAAS_CONSOLE_HOME)} />
  }

  if (loc.pathname === '/dashboard') {
    return withPlatformView(
      saasWrap(
        'saas.nav.dashboard',
        <AnalyticsPage
          saasMode
          appUsername={session.username}
          appRole={session.role}
          appUserScope={session.scope}
          onLogout={doLogout}
        />,
      ),
    )
  }

  if (loc.pathname === '/users') {
    if (isViewerLike(session.role) || !isAdminLike(session.role)) {
      return <Navigate to={SAAS_CONSOLE_HOME} replace />
    }
    return saasWrap(
      'saas.nav.users',
      <UserMgmtPage sessionRole={session.role} sessionScope={session.scope} />,
    )
  }

  if (loc.pathname === '/tenants') {
    if (!isPlatformScope({ scope: session.scope, role: session.role })) {
      return <Navigate to={SAAS_CONSOLE_HOME} replace />
    }
    return withPlatformView(saasWrap('saas.nav.tenants', <TenantsPage />))
  }

  if (loc.pathname === '/shops') {
    return withPlatformView(
      saasWrap(
      'saas.nav.shops',
      <ShopMgmtPage
        username={session.username}
        onLogout={doLogout}
        appRole={session.role as 'admin' | 'super_admin' | 'viewer'}
        appUserScope={session.scope}
      />,
      ),
    )
  }

  if (loc.pathname === '/orders') {
    return withPlatformView(saasWrap('saas.nav.orders', <OrdersPage />))
  }

  if (loc.pathname === '/authorizations') {
    return withPlatformView(saasWrap('saas.nav.authorizations', <AuthorizationsPage />))
  }

  if (loc.pathname === '/sync') {
    return withPlatformView(saasWrap('saas.nav.sync', <SyncCenterPage appRole={session.role} />))
  }

  if (loc.pathname === '/logs') {
    if (isViewerLike(session.role) || !isAdminLike(session.role)) {
      return <Navigate to={SAAS_CONSOLE_HOME} replace />
    }
    return saasWrap('saas.nav.logs', <PlaceholderPage pageKey="logs" />)
  }

  if (loc.pathname === '/settings') {
    if (isViewerLike(session.role) || !isAdminLike(session.role)) {
      return <Navigate to={SAAS_CONSOLE_HOME} replace />
    }
    return saasWrap('saas.nav.settings', <PlaceholderPage pageKey="settings" />)
  }

  /** @deprecated 阶段九：/reconcile 已废弃，重定向至 SaaS 数据总览 */
  if (loc.pathname === '/reconcile') {
    return <Navigate to="/dashboard" replace />
  }

  return <Navigate to={WAR_ROOM_HOME} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<AppShell />} />
      </Routes>
    </BrowserRouter>
  )
}
