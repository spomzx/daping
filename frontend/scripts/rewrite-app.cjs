const fs = require('fs')
const path = require('path')

const appPath = path.join(__dirname, '../src/App.tsx')
const lines = fs.readFileSync(appPath, 'utf8').split(/\r?\n/)

const header = `import { useEffect, useRef, useState, type ReactNode } from 'react'
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
import { TenantsPage } from './pages/Tenants/TenantsPage'
import { PlatformViewTenantProvider } from './context/PlatformViewTenantContext'
import { isPublicRoute, REGISTER_PENDING_CONTACT_KEY } from './authRoutes'
import { apiFetch, fetchAuthMe, postAuthLogout } from './apiClient'
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

`

let shell = lines.slice(2120).join('\n')
shell = shell.replace(/SaasLayout/g, 'AdminLayout')
shell = shell.replace(/GmvDashboard/g, 'LegacyDashboardPage')

fs.writeFileSync(appPath, header + shell)
console.log('App.tsx rewritten')
