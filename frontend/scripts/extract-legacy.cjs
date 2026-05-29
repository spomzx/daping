const fs = require('fs')
const path = require('path')

const appPath = path.join(__dirname, '../src/App.tsx')
const lines = fs.readFileSync(appPath, 'utf8').split(/\r?\n/)
const helpers = lines.slice(59, 818).join('\n')
const dashboard = lines.slice(820, 2119).join('\n')

const header = `import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'
import { RealtimeOrdersPanel } from '../components/RealtimeOrdersPanel'
import {
  isAdminLike,
  isPlatformScope,
  type MeRole,
  type AuthSession,
  type AccountAccess,
} from '../authRole'
import { usePlatformViewTenant } from '../context/PlatformViewTenantContext'
import { TenantViewSelector } from '../components/TenantViewSelector'
import { getPlatformViewTenantId } from '../lib/platformViewTenant'
import { apiFetch, fetchWithAuth } from '../apiClient'
import {
  LS_TIME_RANGE,
  LS_CUSTOM_START,
  LS_CUSTOM_END,
  readInitialTimeRange,
  toCanonicalOrderStatus,
  useI18n,
  type TimeRangePreset,
} from '../i18n'
import { appendDashboardTimeQuery, getDashboardBoundsForQuery } from '../dashboardBounds'
import { formatMoneyByCurrency } from '../currencyDisplay'
import { GmvCompareTrendPanel } from '../GmvCompareTrendPanel'
import { useChartResize } from '../hooks/useChartResize'
import './styles/legacy-dashboard.css'
import {
  buildFallbackExchangeRate,
  buildLoadingExchangeRate,
  isSoftRateStatus,
  readExchangeRateCache,
  writeExchangeRateCache,
} from '../lib/exchangeRateFallback'
import { DashboardHeader } from '../components/DashboardHeader'

`

const renamed = dashboard.replace('function GmvDashboard', 'export function LegacyDashboardPage')
const outDir = path.join(__dirname, '../src/legacy')
const stylesDir = path.join(outDir, 'styles')
fs.mkdirSync(stylesDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'LegacyDashboardPage.tsx'), header + '\n' + helpers + '\n\n' + renamed + '\n')

// Copy legacy-dashboard.css
fs.copyFileSync(
  path.join(__dirname, '../src/styles/legacy-dashboard.css'),
  path.join(stylesDir, 'legacy-dashboard.css'),
)

console.log('extracted LegacyDashboardPage.tsx')
