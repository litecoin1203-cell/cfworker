// The admin panel: Persian, right-to-left, same look as Pleat. Every change goes through the bot's own admin
// actions on the server (roles, audit log, 10-minute undo). Money and destructive ones ask first.
import { useEffect, useState, useCallback } from 'preact/hooks';
import { admin } from './api.js';
import { n, gb, day, ago, METHOD, STATUS, SUB, PANEL_STATE, ROLE } from './fmt.js';
import { Card, Button, Chip, Skeleton, ErrorState, Mark } from '../ui.jsx';
import { webApp, haptic } from '../tg.js';

function ask(message) {
  const w = webApp();
  return new Promise((res) => {
    try { if (w && w.showConfirm && w.isVersionAtLeast && w.isVersionAtLeast('6.2')) return w.showConfirm(message, (ok) => res(!!ok)); } catch (e) { /* fall back */ }
    res(window.confirm(message));
  });
}

// loads data with loading / error states
function useLoad(fn, deps) {
  const [s, set] = useState({ loading: true });
  const load = useCallback(() => { set((o) => ({ ...o, loading: true, error: null })); fn().then((data) => set({ data }), (e) => set({ error: e.message })); }, deps);
  useEffect(load, [load]);
  return [s, load];
}

function Loader({ s, retry, children }) {
  if (s.error) return <ErrorState title="بارگیری نشد" text={s.error} onRetry={retry} />;
  if (!s.data) return <Skeleton />;
  return children(s.data);
}

// a result line at the bottom, with Undo when the change can be undone
function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div class={'toast ' + (toast.ok ? '' : 'bad')} role="status">
      <span>{toast.text}</span>
      {toast.undo ? <button type="button" class="link" onClick={onUndo}>برگردان</button> : null}
      <button type="button" class="link" aria-label="بستن" onClick={onClose}>✕</button>
    </div>
  );
}

// a small form in a bottom sheet: fields [{key, label, type, placeholder}]
function Sheet({ form, onClose }) {
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  if (!form) return null;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await form.onSubmit(vals);
    setBusy(false);
  };
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" onSubmit={submit}>
        <h2>{form.title}</h2>
        {form.hint ? <p class="sub">{form.hint}</p> : null}
        {form.fields.map((f) => (
          <label key={f.key} class="field">
            <span>{f.label}</span>
            {f.options ? (
              <select required value={vals[f.key] || ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                <option value="" disabled>انتخاب کن</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input required={!f.optional} inputMode={f.type === 'number' ? 'numeric' : 'text'} dir={f.type === 'number' ? 'ltr' : 'auto'}
                placeholder={f.placeholder || ''} value={vals[f.key] || ''} onInput={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            )}
          </label>
        ))}
        <div class="two"><Button type="submit" busy={busy}>{form.submit || 'انجام بده'}</Button><button type="button" class="btn ghost" onClick={onClose}>انصراف</button></div>
      </form>
    </div>
  );
}

// ---------------- dashboard ----------------
function Dashboard({ go }) {
  const [s, load] = useLoad(() => admin.dashboard(), []);
  return (
    <Loader s={s} retry={load}>{(d) => {
      const todo = d.review + d.perr;
      return (
        <>
          <div class="grid">
            <Stat label="کاربرها" value={n(d.users)} sub={`${n(d.new_week)} نفر این هفته`} onClick={() => go('users')} />
            <Stat label="اشتراک فعال" value={n(d.active)} onClick={() => go('users', 'act')} />
            <Stat label="فروش ۲۴ ساعت" value={n(d.sales_today)} sub="تومان" />
            <Stat label="فروش ۷ روز" value={n(d.sales_week)} sub="تومان" />
          </div>
          <Card class="line tap" onClick={() => go('inbox')}>
            <span class="label">کارهای منتظر</span>
            {todo ? <Chip tone="alert">{n(todo)}</Chip> : <Chip tone="safe">هیچ</Chip>}
          </Card>
          {d.review ? <p class="sub pad">🧾 {n(d.review)} رسید منتظر بررسی{d.coin ? ` · 💎 ${n(d.coin)} واریز ارز` : ''}</p> : null}
          {d.perr ? <p class="sub pad">⚠️ {n(d.perr)} پنل ساخت اکانت را رد کرده (در ربات › پنل‌ها)</p> : null}
        </>
      );
    }}</Loader>
  );
}

const Stat = ({ label, value, sub, onClick }) => (
  <Card class={'stat' + (onClick ? ' tap' : '')}><div onClick={onClick}><span class="sub">{label}</span><b>{value}</b>{sub ? <span class="sub">{sub}</span> : null}</div></Card>
);

// ---------------- inbox ----------------
function Inbox({ act, openUser }) {
  const [s, load] = useLoad(() => admin.inbox(), []);
  return (
    <Loader s={s} retry={load}>{(d) => d.orders.length ? d.orders.map((o) => <OrderCard key={o.id} o={o} act={act} reload={load} openUser={openUser} />) : (
      <Card class="state"><div class="glyph" aria-hidden="true"><Mark size={30} /></div><h2>کاری منتظر نیست</h2><p>رسید تازه‌ای نیامده.</p></Card>
    )}</Loader>
  );
}

function OrderCard({ o, act, reload, openUser }) {
  const [img, setImg] = useState(null);
  const [imgErr, setImgErr] = useState('');
  const showReceipt = async () => { try { setImg(await admin.receipt(o.id)); } catch (e) { setImgErr(e.message); } };
  const approve = () => act('order.approve', { orderId: o.id }, `سفارش #${o.id} (${n(o.amount_toman)} تومان) تأیید و فعال شود؟`, reload);
  const reject = () => act('order.reject', { orderId: o.id }, null, reload);
  return (
    <Card>
      <div class="row"><span class="label">#{o.id} · {n(o.amount_toman)} تومان</span><Chip tone="muted">{METHOD[o.method] || o.method}</Chip></div>
      <p class="sub"><button type="button" class="link" onClick={() => openUser(o.user_id)}>{o.user}</button> · {o.kind === 'topup' ? 'شارژ کیف پول' : (o.plan ? `${o.plan.name} · ${o.plan.gb || '∞'} گیگ · ${o.plan.days} روز` : 'پلن')}</p>
      <p class="sub"><bdi dir="ltr">{day(o.created_at)}</bdi>{o.receipt_ref ? ` · پیگیری ${o.receipt_ref}` : ''}{o.txid ? ` · tx ${o.txid.slice(0, 12)}…` : ''}</p>
      {o.has_receipt ? (img ? <img class="receipt" src={img} alt={`رسید سفارش ${o.id}`} /> : <button type="button" class="btn ghost" onClick={showReceipt}>🖼 نمایش رسید</button>) : null}
      {imgErr ? <p class="err">{imgErr}</p> : null}
      <div class="two"><Button onClick={approve}>✅ تأیید</Button><button type="button" class="btn danger" onClick={reject}>❌ رد</button></div>
    </Card>
  );
}

// ---------------- users ----------------
const FILTERS = [['all', 'همه'], ['act', 'فعال'], ['exp', 'تمام‌شده'], ['none', 'بی‌پلن'], ['blk', 'مسدود']];

function Users({ openUser, initialFilter }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(initialFilter || 'all');
  const [list, setList] = useState({ loading: true, users: [] });
  const fetchPage = async (before) => {
    setList((l) => ({ ...l, loading: true, error: null }));
    try {
      const r = await admin.users(q.trim(), filter, before);
      setList((l) => ({ users: before ? [...l.users, ...r.users] : r.users, more: r.more, next: r.next }));
    } catch (e) { setList((l) => ({ ...l, loading: false, error: e.message })); }
  };
  useEffect(() => { const t = setTimeout(() => fetchPage(0), q ? 350 : 0); return () => clearTimeout(t); }, [q, filter]);
  return (
    <>
      <input class="search" type="search" placeholder="جستجو: ‎#شناسه، ‎@یوزرنیم، آیدی عددی یا ایمیل" value={q} onInput={(e) => setQ(e.target.value)} aria-label="جستجوی کاربر" />
      <div class="chips" role="tablist">{FILTERS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} class={'chip ' + (filter === k ? 'sel' : '')} onClick={() => setFilter(k)}>{l}</button>)}</div>
      {list.error ? <ErrorState title="بارگیری نشد" text={list.error} onRetry={() => fetchPage(0)} /> : null}
      {!list.error && !list.loading && !list.users.length ? <Card class="state"><h2>کاربری پیدا نشد</h2><p>جستجو یا فیلتر را عوض کن.</p></Card> : null}
      {list.users.map((u) => (
        <Card key={u.id} class="line tap">
          <div class="who-row" onClick={() => openUser(u.id)}>
            <span><b dir="ltr">{u.label}</b>{u.name ? <span class="sub"> · {u.name}</span> : null}</span>
            {u.deleted ? <Chip tone="muted">حذف‌شده</Chip> : u.blocked ? <Chip tone="alert">مسدود</Chip> : u.sub ? <Chip tone={u.sub.active ? 'safe' : 'alert'}>{u.sub.active ? 'فعال' : 'تمام‌شده'}</Chip> : <Chip tone="muted">بی‌پلن</Chip>}
          </div>
        </Card>
      ))}
      {list.loading && !list.users.length ? <Skeleton /> : null}
      {list.more ? <button type="button" class="btn ghost" disabled={list.loading} onClick={() => fetchPage(list.next)}>بیشتر</button> : null}
    </>
  );
}

function UserCard({ id, act, back }) {
  const [s, load] = useLoad(() => admin.user(id), [id]);
  const [panels, setPanels] = useState(null);
  const [plans, setPlans] = useState(null);
  const [form, setForm] = useState(null);
  const readPanels = async () => { setPanels({ loading: true }); try { setPanels(await admin.panels(id)); } catch (e) { setPanels({ error: e.message }); } };
  useEffect(() => {
    const w = webApp();
    if (!w || !w.BackButton) return undefined;
    w.BackButton.show(); w.BackButton.onClick(back);
    return () => { w.BackButton.offClick(back); w.BackButton.hide(); };
  }, [back]);
  const run = (name, args, question) => act(name, { userId: id, ...args }, question, load);
  const sheet = (title, fields, onSubmit, hint) => setForm({ title, fields, hint, onSubmit: async (v) => { await onSubmit(v); setForm(null); } });
  const grant = async () => {
    const p = plans || (await admin.plans()).plans; setPlans(p);
    sheet('🎁 دادن پلن', [{ key: 'planId', label: 'پلن', options: p.map((x) => ({ value: x.id, label: `${x.name} · ${x.data_limit_gb || '∞'} گیگ · ${x.duration_days} روز${x.is_active ? '' : ' (غیرفعال)'}` })) }],
      (v) => run('user.grant', { planId: v.planId }, 'این پلن رایگان به کاربر داده شود؟'));
  };
  return (
    <Loader s={s} retry={load}>{(u) => {
      const sub = u.subscription;
      return (
        <>
          <Card>
            <div class="row"><b dir="ltr">{u.label}</b>{u.deleted ? <Chip tone="muted">حذف‌شده</Chip> : u.blocked ? <Chip tone="alert">مسدود</Chip> : null}</div>
            <p class="sub">#{u.id}{u.name ? ` · ${u.name}` : ''}{u.email ? ` · ${u.email}` : ''}</p>
            <p class="sub">عضویت <bdi dir="ltr">{day(u.created_at)}</bdi> · 🕒 آخرین اتصال: <b class={u.online ? 'ok' : ''}>{u.online ? '🟢 الان آنلاین' : ago(u.last_seen)}</b></p>
          </Card>
          <Card>
            <div class="row"><span class="label">اشتراک</span>{sub ? <Chip tone={sub.active ? 'safe' : 'alert'}>{SUB[sub.status] || sub.status}</Chip> : <Chip tone="muted">ندارد</Chip>}</div>
            {sub ? (
              <>
                <p class="kv"><span>{sub.plan_name || 'پلن'}</span></p>
                <p class="kv"><span>مصرف (جمع همه‌ی پنل‌ها)</span><b dir="ltr">{gb(sub.used_bytes)} / {sub.unlimited_data ? '∞' : gb(sub.data_limit_bytes)} GB</b></p>
                <p class="kv"><span>شروع</span><b dir="ltr">{day(sub.started_at)}</b></p>
                <p class="kv"><span>انقضا</span><b dir="ltr">{sub.unlimited_time ? 'نامحدود' : `${day(sub.expires_at)} (${n(sub.days_left)} روز)`}</b></p>
              </>
            ) : null}
            <div class="actions">
              <button type="button" class="btn ghost" onClick={grant}>🎁 دادن پلن</button>
              {sub ? <button type="button" class="btn ghost" onClick={() => sheet('➕ اضافه کردن روز', [{ key: 'days', label: 'چند روز؟', type: 'number' }], (v) => run('user.add_days', { days: v.days }))}>➕ روز</button> : null}
              {sub ? <button type="button" class="btn ghost" onClick={() => sheet('➕ اضافه کردن حجم', [{ key: 'gb', label: 'چند گیگ؟', type: 'number' }], (v) => run('user.add_gb', { gb: v.gb }))}>➕ گیگ</button> : null}
              {sub ? <button type="button" class="btn ghost" onClick={() => run('user.pause', { on: sub.status === 'disabled' ? '0' : '1' })}>{sub.status === 'disabled' ? '▶️ ادامه' : '⏸ توقف'}</button> : null}
              {sub ? <button type="button" class="btn ghost" onClick={() => run('user.reset_usage', {}, 'مصرف این دوره صفر شود؟')}>🔄 صفر کردن مصرف</button> : null}
            </div>
          </Card>
          <Card>
            <div class="row"><span class="label">پنل‌های کاربر</span><button type="button" class="link" onClick={readPanels}>{panels ? '🔄 دوباره بخوان' : '🗂 زنده از پنل‌ها'}</button></div>
            {!panels ? <p class="sub">مصرف، تاریخ‌ها و آخرین اتصال روی هر پنل، زنده خوانده می‌شود.</p> : panels.loading ? <Skeleton /> : panels.error ? <p class="err">{panels.error}</p> : panels.panels.length ? panels.panels.map((p) => (
              <div class="panel" key={p.panel_id}>
                <div class="row"><b>#{p.panel_id} {p.panel}</b><Chip tone={p.state === 'active' ? 'safe' : p.state === 'no_answer' || p.state === 'missing' ? 'muted' : 'alert'}>{PANEL_STATE[p.state] || p.state}</Chip></div>
                <p class="sub" dir="ltr">👤 {p.username}</p>
                {p.used_bytes != null ? <p class="kv"><span>مصرف روی این پنل</span><b dir="ltr">{gb(p.used_bytes)} / {p.limit_bytes ? gb(p.limit_bytes) : '∞'} GB</b></p> : null}
                {p.created_at || p.expires_at ? <p class="kv"><span>ساخت · انقضا</span><b dir="ltr">{day(p.created_at)} · {day(p.expires_at)}</b></p> : null}
                {p.state !== 'panel_off' && p.state !== 'missing' ? <p class="kv"><span>آخرین اتصال</span><b class={p.online ? 'ok' : ''}>{p.online ? '🟢 الان آنلاین' : ago(p.last_seen)}</b></p> : null}
              </div>
            )) : <p class="sub">روی هیچ پنلی اکانت ندارد.</p>}
          </Card>
          <Card>
            <div class="row"><span class="label">کیف پول</span><b>{n(u.wallet)} تومان</b></div>
            <div class="actions">
              <button type="button" class="btn ghost" onClick={() => sheet('💰 تغییر کیف پول', [{ key: 'amount', label: 'مبلغ به تومان (منفی = کم کردن)', type: 'number' }, { key: 'note', label: 'دلیل' }],
                (v) => run('user.wallet', { amount: String(v.amount).replace(/[^\d-]/g, ''), note: v.note }, `${n(v.amount)} تومان به کیف پول اضافه/کم شود؟`))}>💰 شارژ / کسر</button>
            </div>
            {u.wallet_tx.slice(0, 5).map((t) => <p class="kv" key={t.id}><span><bdi dir="ltr">{day(t.created_at)}</bdi> · {t.note || t.reason}</span><b dir="ltr" class={t.amount < 0 ? 'bad' : 'ok'}>{t.amount > 0 ? '+' : ''}{n(t.amount)}</b></p>)}
          </Card>
          <Card>
            <span class="label">سفارش‌های اخیر</span>
            {u.orders.length ? u.orders.map((o) => <p class="kv" key={o.id}><span>#{o.id} · {METHOD[o.method] || o.method} · <bdi dir="ltr">{day(o.created_at)}</bdi></span><b>{n(o.amount_toman)} · {STATUS[o.status] || o.status}</b></p>) : <p class="sub">سفارشی ندارد.</p>}
          </Card>
          <Card>
            <span class="label">دستگاه‌ها و امنیت</span>
            {u.devices.length ? u.devices.map((d) => <p class="kv" key={d.id}><span dir="ltr">{d.model || d.id.slice(0, 12)}</span><b>{ago(d.last_seen)}</b></p>) : <p class="sub">دستگاهی ثبت نشده.</p>}
            <div class="actions">
              <button type="button" class="btn ghost" onClick={() => run('user.logout_all', {})}>🚪 خروج از همه‌ی دستگاه‌ها</button>
              {!u.deleted ? <button type="button" class="btn ghost" onClick={() => run('user.block', { on: u.blocked ? '0' : '1' })}>{u.blocked ? '✅ رفع مسدودی' : '🚫 مسدود کردن'}</button> : null}
            </div>
          </Card>
          <Sheet form={form} onClose={() => setForm(null)} />
        </>
      );
    }}</Loader>
  );
}

// ---------------- shell ----------------
const TABS = [['home', 'داشبورد'], ['inbox', 'رسیدها'], ['users', 'کاربران']];

export function AdminApp({ onSwitch }) {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState({ name: 'home' });
  const [userId, setUserId] = useState(null);
  const [toast, setToast] = useState(null);
  const start = useCallback(() => { setErr(''); admin.auth().then(setMe, (e) => setErr(e.message)); }, []);
  useEffect(() => { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'fa'; start(); }, []);

  // runs one admin action: asks first when a question is given, shows the result, offers Undo
  const act = useCallback(async (name, args, question, after) => {
    if (question && !(await ask(question))) return;
    try {
      const r = await admin.action(name, args, !!question);
      haptic(r.ok ? 'success' : 'error');
      setToast({ ok: r.ok, text: r.ok ? r.text : r.error, undo: r.ok && r.undoable ? r.audit_id : null });
      if (r.ok && after) after();
    } catch (e) { haptic('error'); setToast({ ok: false, text: e.message }); }
  }, []);
  const undo = async () => {
    try { const r = await admin.undo(toast.undo); setToast({ ok: r.ok, text: r.ok ? r.text : r.error }); } catch (e) { setToast({ ok: false, text: e.message }); }
  };
  const go = (name, filter) => { setUserId(null); setTab({ name, filter }); };
  const back = useCallback(() => setUserId(null), []);

  let body;
  if (err) body = <ErrorState title="ورود مدیر انجام نشد" text={err} onRetry={start} />;
  else if (!me) body = <Skeleton />;
  else if (userId) body = <UserCard id={userId} act={act} back={back} />;
  else if (tab.name === 'inbox') body = <Inbox act={act} openUser={setUserId} />;
  else if (tab.name === 'users') body = <Users openUser={setUserId} initialFilter={tab.filter} />;
  else body = <Dashboard go={go} />;

  return (
    <main class="admin">
      <header class="top">
        <div class="brand"><Mark /><span>مدیریت Pleat</span></div>
        {me ? <button type="button" class="chip" onClick={onSwitch} title="حساب کاربری خودم">{ROLE[me.role] || me.role}</button> : null}
      </header>
      <div class="stack" aria-live="polite">{body}</div>
      <Toast toast={toast} onUndo={undo} onClose={() => setToast(null)} />
      <nav class="tabs" aria-label="بخش‌ها">
        {TABS.map(([k, l]) => <button key={k} type="button" aria-current={!userId && tab.name === k ? 'page' : undefined} class={!userId && tab.name === k ? 'on' : ''} onClick={() => go(k)}>{l}</button>)}
      </nav>
    </main>
  );
}
