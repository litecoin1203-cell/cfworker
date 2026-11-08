// Reusable pieces in Pleat's language: white radius-30 cards, pill buttons, slanted pleats, day dots.

export function Mark({ size = 34 }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <path d="M8 6h14l-6 24H2z" fill="var(--navy)" />
      <path d="M17 3h14l-6 24H11z" fill="var(--blue)" opacity=".92" />
    </svg>
  );
}

export function Header({ name }) {
  return (
    <header class="top">
      <div class="brand"><Mark /><span>Pleat</span></div>
      {name ? <div class="who" aria-label={'Signed in as ' + name}>{name.slice(0, 1).toUpperCase()}</div> : null}
    </header>
  );
}

export const Card = ({ children, class: cls = '', onClick }) => <section class={'card ' + cls} onClick={onClick}>{children}</section>;

export function Button({ children, onClick, busy, kind = 'primary', type = 'button' }) {
  return (
    <button type={type} class={'btn ' + kind} onClick={onClick} disabled={busy} aria-busy={busy ? 'true' : 'false'}>
      {busy ? <span class="spin" aria-hidden="true" /> : null}{children}
    </button>
  );
}

export const Chip = ({ tone, children }) => <span class={'chip ' + tone}>{children}</span>;

// data as slanted pleats: full ones are data left
export function Pleats({ left, total = 10 }) {
  return (
    <div class="pleats" role="img" aria-label={`${left} of ${total} parts of your data left`}>
      {Array.from({ length: total }, (_, i) => <i key={i} class={i < left ? 'on' : ''} />)}
    </div>
  );
}

// days as dots: filled ones are days left
export function Dots({ total, left }) {
  return (
    <div class="dots" role="img" aria-label={`${left} of ${total} days left`}>
      {Array.from({ length: total }, (_, i) => <i key={i} class={i >= total - left ? 'on' : ''} />)}
    </div>
  );
}

export function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Card><div class="sk w40" /><div class="sk big" /><div class="sk w60" /><div class="sk bar" /></Card>
      <Card><div class="sk w60" /><div class="sk w40" /></Card>
    </div>
  );
}

export function ErrorState({ title, text, onRetry }) {
  return (
    <Card class="state">
      <div class="glyph alert" aria-hidden="true">!</div>
      <h2>{title}</h2>
      <p>{text}</p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </Card>
  );
}

export function EmptyState({ title, text, children }) {
  return (
    <Card class="state">
      <div class="glyph" aria-hidden="true"><Mark size={30} /></div>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </Card>
  );
}
