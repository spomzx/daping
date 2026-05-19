import { useT } from '../i18n'

export function PlaceholderPage({ pageKey }: { pageKey: string }) {
  const t = useT()
  return (
    <div className="saas-placeholder">
      <h2>{t(`saas.placeholder.${pageKey}.title`)}</h2>
      <p>{t(`saas.placeholder.${pageKey}.desc`)}</p>
    </div>
  )
}
