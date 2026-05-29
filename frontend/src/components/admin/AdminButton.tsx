import type { ButtonHTMLAttributes } from 'react'

export type AdminButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export type AdminButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: AdminButtonVariant
  active?: boolean
}

export function AdminButton({
  variant = 'secondary',
  active = false,
  className,
  type = 'button',
  ...props
}: AdminButtonProps) {
  const classes = [
    'admin-btn',
    `admin-btn--${variant}`,
    active ? 'admin-btn--active' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return <button type={type} className={classes} {...props} />
}
