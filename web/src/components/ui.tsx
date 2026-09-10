import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';

/* -------------------------------------------------------------- surfaces */

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-hairline bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-axis px-3 py-6 text-center text-xs text-muted">
      {children}
    </p>
  );
}

/* --------------------------------------------------------------- controls */

type Variant = 'primary' | 'default' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:opacity-90 border-transparent',
  default: 'bg-raised text-ink border-hairline hover:border-axis',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-raised hover:text-ink',
  danger: 'bg-transparent text-critical border-hairline hover:border-critical',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'h-7 px-2.5 text-xs',
    md: 'h-9 px-3.5 text-sm',
    lg: 'h-11 px-5 text-base',
  } as const;
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium
        transition-colors disabled:cursor-not-allowed disabled:opacity-40
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
        ${sizes[size]} ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/** Width is deliberately absent so callers can size inputs without a conflict. */
export const inputBase =
  'rounded-lg border border-hairline bg-raised px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted focus:border-accent focus:outline-none';

export const inputClass = `${inputBase} w-full`;

/** A colour swatch always sits beside a text label — never identity by hue alone. */
export function Swatch({ color, className = '' }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2.5 shrink-0 rounded-full ${className}`}
      style={{ background: color }}
    />
  );
}

/* ----------------------------------------------------------------- dialog */

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full ${width} rounded-2xl border border-hairline bg-surface p-5 shadow-xl`}
      >
        <h2 id={titleId} className="mb-4 text-base font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- tooltip */

const TooltipCtx = createContext(false);

/**
 * Hover detail for a mark. The wrapper is the hit target, so it should be at
 * least as large as the mark it belongs to.
 */
export function WithTooltip({
  content,
  children,
  className = '',
  style,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const nested = useContext(TooltipCtx);
  if (nested) return <>{children}</>;
  return (
    <TooltipCtx.Provider value={true}>
      <span className={`group/tip relative block ${className}`} style={style}>
        {children}
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden
            -translate-x-1/2 whitespace-nowrap rounded-lg border border-hairline bg-raised
            px-2.5 py-1.5 text-[11px] leading-snug text-ink shadow-lg group-hover/tip:block"
        >
          {content}
        </span>
      </span>
    </TooltipCtx.Provider>
  );
}
