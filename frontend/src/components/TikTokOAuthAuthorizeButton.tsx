import { useState } from 'react'
import { fetchTikTokServiceAuthorizeUrl } from '../tiktokOAuth'

type TikTokOAuthAuthorizeButtonProps = {
  className?: string
}

export function TikTokOAuthAuthorizeButton({ className }: TikTokOAuthAuthorizeButtonProps) {
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
    <div className={['tiktok-oauth-single-wrap', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="admin-btn admin-btn--primary tiktok-oauth-single-btn"
        disabled={busy}
        onClick={() => void onAuthorize()}
      >
        {busy ? '跳转中…' : '授权'}
      </button>
      {err ? (
        <p className="tiktok-oauth-single-err" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  )
}
