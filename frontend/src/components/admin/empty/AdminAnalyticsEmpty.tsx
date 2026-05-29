import type { ReactNode } from 'react'
import { AdminEmptyState, type AdminEmptyVariant } from './AdminEmptyState'

export type AdminAnalyticsEmptyProps = {
  variant?: AdminEmptyVariant
  title?: ReactNode
  description?: ReactNode
  className?: string
}

export function AdminAnalyticsEmpty({ variant = 'empty', title, description, className }: AdminAnalyticsEmptyProps) {
  return (
    <AdminEmptyState
      variant={variant}
      layout="analytics"
      title={title}
      description={description}
      className={className}
    />
  )
}
