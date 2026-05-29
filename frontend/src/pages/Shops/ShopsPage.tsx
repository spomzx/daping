import { useSearchParams } from 'react-router-dom'
import { ShopMgmtPanel } from '../../ShopMgmtPanel'
import { isAdminLike, isPlatformScope, isSuperAdmin, type MeRole, type UserScope } from '../../authRole'
import { useT } from '../../i18n'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'

export function ShopsPage({
  appRole,
  appUserScope = 'tenant',
}: {
  appRole: Extract<MeRole, 'admin' | 'super_admin' | 'viewer'>
  appUserScope?: UserScope
}) {
  const t = useT()
  const [searchParams] = useSearchParams()
  const initialHealthFilter = searchParams.get('healthFilter')
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })

  return (
    <div className="saas-admin-page saas-shops-page">
      <SaasPageFrame title={t('shopMgmt.drawerTitle')} description={t('shopMgmt.pageSubtitle')}>
        <ShopMgmtPanel
        variant="page"
        shellChrome
        serverPagination
        initialHealthFilter={initialHealthFilter}
        username=""
        canRefreshHealth={isAdminLike(appRole) || platformScope}
        hasPlatformScope={platformScope}
        canViewOperationLogs={isSuperAdmin(appRole)}
        />
      </SaasPageFrame>
    </div>
  )
}
