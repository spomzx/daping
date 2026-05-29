import { useState } from 'react'
import { fetchTikTokServiceAuthorizeUrl } from '../tiktokOAuth'

type TikTokOAuthMarketButtonsProps = {
  className?: string
}

export function TikTokOAuthMarketButtons({ className }: TikTokOAuthMarketButtonsProps) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onAuthorize() {
    setErr(null)
    setBusy(true)
    try {
      const authorize_url = await fetchTikTokServiceAuthorizeUrl()
      window.location.href = authorize_url
    } catch (e) {
      setErr(String((e as Error)?.message || e))
      setBusy(false)
    }
  }

  return (
    <div className={['tiktok-oauth-cards-wrap', className].filter(Boolean).join(' ')}>
      <article className="tiktok-oauth-card">
        <button
          type="button"
          className="admin-btn admin-btn--primary tiktok-oauth-card__action"
          disabled={busy}
          onClick={() => void onAuthorize()}
        >
          {busy ? '跳转中…' : '授权 TikTok 店铺'}
        </button>
        {err ? <p className="tiktok-oauth-debug-hint" role="alert">{err}</p> : null}
      </article>
    </div>
  )
}
