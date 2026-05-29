import { useT } from '../i18n'
import { AdminSection } from '../components/admin'
import { SaasPageFrame } from '../components/layout/SaasPageFrame'

export function PlaceholderPage({ pageKey }: { pageKey: string }) {
  const t = useT()
  const desc = t(`saas.placeholder.${pageKey}.desc`)

  return (
    <SaasPageFrame description={desc}>
      <AdminSection variant="default" title={t(`saas.placeholder.${pageKey}.title`)}>
        <p className="admin-section__desc" style={{ margin: 0 }}>
          {desc}
        </p>
      </AdminSection>
    </SaasPageFrame>
  )
}
