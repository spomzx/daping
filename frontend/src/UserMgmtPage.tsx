import type { UserScope } from './authRole'
import { UsersPage } from './pages/Users/UsersPage'

/** @deprecated 请使用 pages/Users/UsersPage；保留导出供 App 过渡 */
export function UserMgmtPage({
  sessionRole,
  sessionScope,
}: {
  onLogout?: () => void
  sessionRole: string
  sessionScope?: UserScope
}) {
  return <UsersPage sessionRole={sessionRole} sessionScope={sessionScope} />
}
