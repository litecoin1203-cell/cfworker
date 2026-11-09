// Reusable pieces in Pleat's language: list rows with an icon and an uppercase pill, round icon actions,
// the big number with shards, slanted pleats, day dots, bottom sheets for forms, a toast with Undo.
import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon } from './icons.jsx';
import { haptic, webApp } from './tg.js';

export function Mark({ size = 34 }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <path d="M8 6h14l-6 24H2z" fill="var(--navy)" />
      <path d="M17 3h14l-6 24H11z" fill="var(--blue)" opacity=".92" />
    </svg>
  );
}

export const initial = (s) => String(s || '?').replace(/^[@#]/, '').trim().slice(0, 1).toUpperCase() || '?';
const TONES = ['', 'b', 'i'];
export function Avatar({ label, online, size = '', seed = 0 }) {
  return (
    <span class={`avatar ${size} ${TONES[Math.abs(seed) % 3]}`} aria-hidden="true">
      {initial(label)}{online ? <i class="on" /> : null}
    </span>
  );
}

export function Title({ title, sub, children }) {
  return (
    <header class="title">
      <h1>{title}{sub ? <span class="sub">{sub}</span> : null}</h1>
      {children}
    </header>
  );
}

export function Section({ title, link, onLink }) {
  return (
    <div class="sec"><h2>{title}</h2>{link ? <button type="button" class="link" onClick={onLink}>{link}</button> : null}</div>
  );
}

export const List = ({ children }) => <div class="list">{children}</div>;

export function Row({ icon, avatar, title, sub, end, onClick, danger, chevron, wrap, disabled }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} class={'row' + (danger ? ' danger' : '')} onClick={onClick} disabled={disabled}>
      {avatar || (icon ? <Icon name={icon} /> : null)}
      <span class="tx"><b>{title}</b>{sub ? <small class={wrap ? 'wrap' : ''}>{sub}</small> : null}</span>
      {end != null || chevron ? <span class="end">{end}{chevron ? <Icon name="chevron" size={20} /> : null}</span> : null}
    </Tag>
  );
}

export function Act({ children, kind = '', onClick, disabled }) {
  return <button type="button" class={'act ' + kind} onClick={(e) => { e.stopPropagation(); onClick && onClick(e); }} disabled={disabled}>{children}</button>;
}

export const Tag = ({ tone = '', children }) => <span class={'tag ' + tone}>{children}</span>;

export function Button({ children, onClick, busy, kind = 'primary', type = 'button', disabled }) {
  return (
    <button type={type} class={'btn ' + kind} onClick={onClick} disabled={busy || disabled} aria-busy={busy ? 'true' : 'false'}>
      {busy ? <span class="spin" aria-hidden="true" /> : null}{children}
    </button>
  );
}

export function Chips({ items, value, onChange }) {
  return (
    <div class="chips" role="tablist">
      {items.map((it) => (
        <button type="button" role="tab" aria-selected={value === it.k} class={'chip' + (value === it.k ? ' on' : '')} onClick={() => { haptic('light'); onChange(it.k); }}>
          {it.label}{it.count != null ? <em>{it.count}</em> : null}
        </button>
      ))}
    </div>
  );
}

export function Seg({ items, value, onChange }) {
  return (
    <div class="seg" role="tablist">
      {items.map((it) => (
        <button type="button" role="tab" aria-selected={value === it.k} class={value === it.k ? 'on' : ''} onClick={() => onChange(it.k)}>
          {it.icon ? <Icon name={it.icon} size={20} /> : null}{it.label}{it.count ? <span class="cnt">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Search({ value, onInput, placeholder }) {
  const [v, setV] = useState(value || '');
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <label class="search">
      <Icon name="search" />
      <input type="search" value={v} placeholder={placeholder} enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck={false}
        onInput={(e) => { const x = e.currentTarget.value; setV(x); clearTimeout(t.current); t.current = setTimeout(() => onInput(x.trim()), 350); }} />
      {v ? <button type="button" class="iconbtn" aria-label="Clear" onClick={() => { setV(''); onInput(''); }}><Icon name="close" size={20} /></button> : null}
    </label>
  );
}

export function Pleats({ left, total = 12, sm }) {
  return <div class={'pleats' + (sm ? ' sm' : '')} aria-hidden="true">{Array.from({ length: total }, (_, i) => <i class={i < left ? 'on' : ''} />)}</div>;
}

export function Dots({ total, left }) {
  return <div class="dots" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i class={i >= total - left ? 'on' : ''} />)}</div>;
}

// Pleat's shards (lib/design/geometry.dart): horizontal tops, sides leaning "/", round corners
export function Shards() {
  return (
    <svg class="art" viewBox="0 0 390 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g stroke-linejoin="round">
        <path d="M130 46h82l-66 112H64z" fill="var(--mist)" stroke="var(--mist)" stroke-width="28" />
        <path d="M300 34h62L238 250h-62z" fill="var(--navy)" stroke="var(--navy)" stroke-width="30" />
        <path d="M240 214h150l-48 86H192z" fill="var(--blue)" stroke="var(--blue)" stroke-width="28" opacity=".9" />
        <path d="M70 232h64l-36 68H34z" fill="var(--ice)" stroke="var(--ice)" stroke-width="22" />
      </g>
    </svg>
  );
}

export function Hero({ label, num, unit, cta, onCta, pill }) {
  const digits = String(num).length;
  return (
    <section class="hero">
      <Shards />
      <div class="lab">{label}</div>
      <div class="num">{num}</div>
      <div class="unit" style={{ left: `${26 + digits * 72}px` }}>{unit}</div>
      {cta ? <button type="button" class="cta" onClick={() => { haptic('medium'); onCta(); }}>{cta}</button> : null}
      {pill ? <div class="pill">{pill}</div> : null}
    </section>
  );
}

export const KV = ({ k, children }) => <div class="kv"><span>{k}</span><span>{children}</span></div>;

export function Toggle({ on, onChange, label, disabled }) {
  return <button type="button" role="switch" aria-checked={on ? 'true' : 'false'} aria-label={label} class={'tog' + (on ? ' on' : '')} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Skeleton({ rows = 3, hero }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {hero ? <div class="sk big" /> : null}
      {Array.from({ length: rows }, () => <div class="sk row" />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div class="state" role="alert">
      <div class="glyph bad"><Icon name="warn" size={28} /></div>
      <h2>Something went wrong</h2>
      <p>{message}</p>
      {onRetry ? <Button kind="soft" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function EmptyState({ icon = 'check', title, text, children }) {
  return (
    <div class="state">
      <div class="glyph"><Icon name={icon} size={28} /></div>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
      {children}
    </div>
  );
}

// ---------------- overlays: one toast, one sheet, one photo viewer at a time ----------------
const bus = { set: null };
const emit = (patch) => bus.set && bus.set((s) => ({ ...s, ...patch }));

let toastTimer = 0;
export function toast(text, opts = {}) {
  clearTimeout(toastTimer);
  emit({ toast: { text, ...opts, id: Date.now() } });
  toastTimer = setTimeout(() => emit({ toast: null }), opts.undo ? 8000 : 3500);
}

// a form in a bottom sheet; resolves with the values, or null when closed
export function openForm(spec) {
  return new Promise((resolve) => emit({ form: { ...spec, resolve } }));
}

export function viewPhoto(src) { emit({ photo: src }); }

// Telegram's own confirm dialog (window.confirm outside Telegram)
export function confirmDialog(text) {
  const w = webApp();
  if (w && w.showConfirm && w.isVersionAtLeast && w.isVersionAtLeast('6.2')) return new Promise((r) => w.showConfirm(String(text).slice(0, 250), (ok) => r(!!ok)));
  return Promise.resolve(typeof window !== 'undefined' && window.confirm ? window.confirm(text) : false);
}

function Form({ spec, close }) {
  const init = {};
  for (const f of spec.fields) init[f.key] = f.value ?? (f.type === 'toggle' ? false : '');
  const [vals, setVals] = useState(init);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    for (const f of spec.fields) {
      if (f.required && String(vals[f.key] ?? '').trim() === '') { setError(`${f.label} is needed.`); return; }
    }
    if (spec.onSubmit) {
      setBusy(true); setError('');
      try { const r = await spec.onSubmit(vals); if (r === false) { setBusy(false); return; } } catch (x) { setBusy(false); setError(x.message || String(x)); haptic('error'); return; }
    }
    close(vals);
  };
  return (
    <form class="sheet fade" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
      <div class="grab" />
      <h2>{spec.title}</h2>
      {spec.lead ? <p class="lead">{spec.lead}</p> : null}
      {spec.fields.map((f) => (f.type === 'toggle' ? (
        <div class="switch"><span>{f.label}</span><Toggle on={!!vals[f.key]} label={f.label} onChange={(v) => set(f.key, v)} /></div>
      ) : (
        <label class="field">
          <span>{f.label}</span>
          {f.type === 'select' ? (
            <select value={vals[f.key]} onChange={(e) => set(f.key, e.currentTarget.value)}>
              {f.options.map((o) => <option value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea value={vals[f.key]} placeholder={f.placeholder || ''} maxLength={f.max || 4000} dir="auto" onInput={(e) => set(f.key, e.currentTarget.value)} />
          ) : (
            <input type={f.type === 'number' ? 'text' : f.type || 'text'} inputMode={f.type === 'number' ? 'numeric' : undefined} value={vals[f.key]}
              placeholder={f.placeholder || ''} autocomplete={f.type === 'password' ? 'new-password' : 'off'} autocapitalize="off" spellcheck={false} dir="auto"
              maxLength={f.max || 300} onInput={(e) => set(f.key, f.type === 'number' ? e.currentTarget.value.replace(/[^\d-]/g, '') : e.currentTarget.value)} />
          )}
          {f.quick ? <div class="quick">{f.quick.map((q) => <button type="button" onClick={() => set(f.key, String(q.value))}>{q.label}</button>)}</div> : null}
          {f.hint ? <small>{f.hint}</small> : null}
        </label>
      )))}
      {error ? <p class="err" role="alert">{error}</p> : null}
      <div class="btns">
        <Button kind="ghost" onClick={() => close(null)}>Cancel</Button>
        <Button type="submit" busy={busy} kind={spec.danger ? 'danger' : 'primary'}>{spec.submit || 'Save'}</Button>
      </div>
    </form>
  );
}

export function Overlays() {
  const [s, setS] = useState({ toast: null, form: null, photo: null });
  useEffect(() => { bus.set = setS; return () => { bus.set = null; }; }, []);
  const closeForm = (v) => { const f = s.form; setS((x) => ({ ...x, form: null })); if (f) f.resolve(v); };
  return (
    <>
      {s.form ? <div class="scrim" onClick={() => closeForm(null)}><Form spec={s.form} close={closeForm} key={s.form.title} /></div> : null}
      {s.photo ? (
        <div class="viewer" onClick={() => setS((x) => ({ ...x, photo: null }))}>
          <img src={s.photo} alt="Receipt" />
          <button type="button" class="iconbtn" aria-label="Close"><Icon name="close" /></button>
        </div>
      ) : null}
      {s.toast ? (
        <div class={'toast fade' + (s.toast.bad ? ' bad' : '')} role="status" key={s.toast.id}>
          <span>{s.toast.text}</span>
          {s.toast.undo ? <button type="button" onClick={() => { setS((x) => ({ ...x, toast: null })); s.toast.undo(); }}>Undo</button> : null}
        </div>
      ) : null}
    </>
  );
}
