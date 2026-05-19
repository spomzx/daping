import { ShopsPage } from './pages/Shops/ShopsPage'
import type { MeRole, UserScope } from './authRole'

/** /shops — 内容由 SaasLayout 包裹，见 pages/Shops/ShopsPage */
export function ShopMgmtPage({
  appRole,
  appUserScope = 'tenant',
}: {
  username: string
  onLogout: () => void
  appRole: Extract<MeRole, 'admin' | 'super_admin' | 'viewer'>
  appUserScope?: UserScope
}) {
  return <ShopsPage appRole={appRole} appUserScope={appUserScope} />
}
