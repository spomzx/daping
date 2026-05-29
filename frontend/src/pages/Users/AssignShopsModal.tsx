import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import {
  fetchAssignableShops,
  fetchUserShopPermissions,
  updateUserShopPermissions,
  usersApiErrorMessage,
  type AssignableShop,
  type UserRow,
} from '../../services/api/users'

type Props = {
  user: UserRow
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export function AssignShopsModal({ user, open, onClose, onSaved }: Props) {
  const t = useT()
  const userId = Number(user.id)
  const [allShops, setAllShops] = useState<AssignableShop[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [platform, setPlatform] = useState('')
  const [region, setRegion] = useState('')

  const load = useCallback(async () => {
    if (!Number.isFinite(userId) || userId <= 0) return
    setLoading(true)
    setErr(null)
    try {
      const [perm, assignable] = await Promise.all([
        fetchUserShopPermissions(userId),
        fetchAssignableShops(),
      ])
      const ids = new Set(
        (perm.shops || []).map((s) => Number(s.shop_id)).filter((n) => Number.isFinite(n) && n > 0),
      )
      setSelected(ids)
      setAllShops(Array.isArray(assignable.shops) ? assignable.shops : [])
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setLoading(false)
    }
  }, [userId, t])

  useEffect(() => {
    if (open) {
      setKeyword('')
      setPlatform('')
      setRegion('')
      void load()
    }
  }, [open, load])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return allShops.filter((s) => {
      if (platform && String(s.platform || '') !== platform) return false
      const r = String(s.region || '').toUpperCase()
      if (region && region !== 'ALL' && r !== region.toUpperCase()) return false
      if (!kw) return true
      const name = String(s.shop_name || '').toLowerCase()
      return name.includes(kw) || String(s.shop_id).includes(kw)
    })
  }, [allShops, keyword, platform, region])

  const platforms = useMemo(() => {
    const set = new Set<string>()
    for (const s of allShops) {
      if (s.platform) set.add(String(s.platform))
    }
    return [...set].sort()
  }, [allShops])

  const regions = useMemo(() => {
    const set = new Set<string>()
    for (const s of allShops) {
      const r = String(s.region || '').toUpperCase()
      if (r) set.add(r)
    }
    return [...set].sort()
  }, [allShops])

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const s of filtered) {
        const id = Number(s.shop_id)
        if (Number.isFinite(id) && id > 0) next.add(id)
      }
      return next
    })
  }

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await updateUserShopPermissions(userId, [...selected])
      onSaved()
      onClose()
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="users-modal-backdrop" role="presentation" onClick={() => !saving && onClose()}>
      <div className="users-modal users-modal--wide" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="users-modal__title">
          {t('users.assignShopsTitle', { username: user.username ?? userId })}
        </h3>
        <p className="users-modal__hint">{t('users.assignShopsHint')}</p>

        <div className="saas-module-toolbar users-assign-filters">
          <label>
            {t('users.filter.keyword')}
            <input
              className="users-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('users.filter.keywordPlaceholder')}
            />
          </label>
          <label>
            {t('users.filter.platform')}
            <select className="locale-select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">{t('sync.filter.all')}</option>
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('users.filter.region')}
            <select className="locale-select" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">{t('sync.filter.all')}</option>
              <option value="ALL">ALL</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="refresh-btn" onClick={() => selectAllFiltered()}>
            {t('users.assignSelectFiltered')}
          </button>
        </div>

        {err ? <p className="warn-text">{err}</p> : null}
        {loading ? <p className="saas-page-frame__loading">{t('common.loading')}</p> : null}

        {!loading ? (
          <div className="users-assign-list">
            {filtered.length === 0 ? (
              <p className="saas-page-frame__empty">{t('empty.noData')}</p>
            ) : (
              filtered.map((s) => {
                const id = Number(s.shop_id)
                const checked = selected.has(id)
                return (
                  <label key={id} className="users-assign-row">
                    <input type="checkbox" checked={checked} onChange={() => toggle(id)} />
                    <span className="users-assign-row__name">{s.shop_name || id}</span>
                    <span className="users-assign-row__meta">
                      {s.platform || '—'} · {s.region || '—'}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        ) : null}

        <p className="users-modal__summary">
          {t('users.assignSelectedCount', { count: selected.size })}
        </p>

        <div className="users-modal__actions">
          <button type="button" className="refresh-btn" disabled={saving || loading} onClick={() => void save()}>
            {saving ? t('btn.submitting') : t('btn.save')}
          </button>
          <button type="button" className="refresh-btn" disabled={saving} onClick={onClose}>
            {t('btn.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
