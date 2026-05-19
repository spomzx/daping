import { forwardRef, useState, type CSSProperties, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export type PasswordInputProps = {
  value: string
  onChange: InputHTMLAttributes<HTMLInputElement>['onChange']
  placeholder?: string
  name?: string
  autoComplete?: string
  disabled?: boolean
  className?: string
  style?: CSSProperties
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'>

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { value, onChange, placeholder, name, autoComplete, disabled, className, style, id, ...rest },
  ref,
) {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        ref={ref}
        id={id}
        name={name}
        type={showPassword ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        autoComplete={autoComplete}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          ...style,
          paddingRight: 36,
        }}
        {...rest}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={showPassword ? '隐藏密码' : '显示密码'}
        onClick={() => setShowPassword((v) => !v)}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: '#8aa4c8',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.35 : 0.72,
          transition: 'opacity 0.15s ease, color 0.15s ease',
          borderRadius: '0 6px 6px 0',
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.opacity = '1'
            e.currentTarget.style.color = '#b8d4ff'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = disabled ? '0.35' : '0.72'
          e.currentTarget.style.color = '#8aa4c8'
        }}
      >
        {showPassword ? (
          <EyeOff size={16} strokeWidth={2} aria-hidden />
        ) : (
          <Eye size={16} strokeWidth={2} aria-hidden />
        )}
      </button>
    </div>
  )
})
