// Users: Telegram username first, data and days left at a glance. The user card is Pleat's package sheet (the big
// number, pleats, day dots) with round actions under it, every panel read live, and the account's tools.
import { useState, useEffect } from 'preact/hooks';
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Chips, Search, Tag, Act, Button, EmptyState, Avatar, Pleats, Dots, KV, openForm, toast } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, gb, ago, day, plural, subState, pleatsLeft, ACCOUNT_STATE, TX_REASON, NET_KIND } from './fmt.js';
import { OrderRow } from './orders.jsx';

const FILTERS = [{ k: 'all', label: 'All' }, { k: 'act', label: 'Active' }, { k: 'exp', label: 'Ended' }, { k: 'none', label: 'No plan' }, { k: 'blk', label: 'Blocked' }];

function userSub(u) {
  if (u.deleted) return 'Deleted';
  if (!u.sub) return `No plan · joined ${day(u.created_at)}`;
  const s = u.sub;
  const data = s.limit_bytes ? `${gb(Math.max(0, s.limit_bytes - s.used_bytes))} GB left` : 'Unlimited data';
  const days = s.days_left == null ? 'no end date' : s.active ? plural(s.days_left, 'day') + ' left' : 'ended';
  return `${data} · ${days}${u.online ? ' · online' : ''}`;
}

export function UserRow({ u, nav }) {
  const ending = u.sub && u.sub.active && u.sub.days_left != null && u.sub.days_left <= 3;
  return (
    <Row avatar={<Avatar label={u.label} online={u.online} size="sm" seed={u.id} />} title={<bdi>{u.label}</bdi>}
      sub={<>{userSub(u)}{u.sub && u.sub.limit_bytes ? <Pleats sm total={10} left={pleatsLeft(u.sub.used_bytes, u.sub.limit_bytes, 10)} /> : null}</>}
      end={u.blocked ? <Tag tone="bad">Blocked</Tag> : u.deleted ? <Tag>Deleted</Tag> : ending ? <Tag tone="warn">Ending</Tag> : !u.sub ? <Tag>No plan</Tag> : u.sub && !u.sub.active ? <Tag tone="bad">Ended</Tag> : null}
      chevron onClick={() => nav.push('user', { id: u.id })} />
  );
}

export async function newUserForm(nav) {
  await openForm({
    title: 'New user', lead: 'An email account made by hand. You can give a plan right after.', submit: 'Create',
    fields: [{ key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'name@gmail.com' }, { key: 'password', label: 'Password', type: 'password', required: true, hint: '8 to 128 characters. Stored only as a hash.' }],
    onSubmit: async (v) => {
      const r = await admin.createUser(v.email.trim(), v.password);
      if (!r.ok) throw new Error(r.error);
      toast('User created');
      if (r.target_id) nav.push('user', { id: r.target_id });
    },
  });
}

export function Users({ nav }) {
  const [f, setF] = useState({ q: '', filter: 'all' });
  const [pages, setPages] = useState([]);
  const st = useLoad(() => admin.users(f), [f.q, f.filter]);
  useEffect(() => setPages([]), [f.q, f.filter]);
  const counts = st.data && st.data.counts;
  const lastPage = pages.length ? pages[pages.length - 1] : st.data;
  const more = async () => {
    try { const p = await admin.users({ ...f, before: lastPage.next }); setPages((x) => [...x, p]); } catch (e) { toast(e.message, { bad: true }); }
  };
  return (
    <Page title="Users" nav={nav} right={nav.role === 'owner' ? <button type="button" class="iconbtn" aria-label="New user" onClick={() => newUserForm(nav)}><Icon name="plus" /></button> : null}>
      <Search placeholder="@username, id or email" value={f.q} onInput={(q) => setF((x) => ({ ...x, q }))} />
      {!f.q ? <Chips items={FILTERS.map((x) => ({ ...x, count: counts ? counts[x.k] : null }))} value={f.filter} onChange={(filter) => setF((x) => ({ ...x, filter }))} /> : null}
      <Loading st={st} rows={6}>
        {(d) => (d.users.length ? (
          <>
            <Section title={f.q ? 'Found' : 'Newest first'} />
            <List>{[d, ...pages].flatMap((p) => p.users).map((u) => <UserRow u={u} nav={nav} key={u.id} />)}</List>
            {lastPage && lastPage.more ? <div style={{ marginTop: '12px' }}><Button kind="soft" onClick={more}>Show more</Button></div> : null}
          </>
        ) : <EmptyState icon="search" title="Nobody here" text={f.q ? 'No user matches that. Try the numeric Telegram id or part of the email.' : 'No user in this filter.'} />)}
      </Loading>
    </Page>
  );
}

// ---------------- the user card ----------------
let planCache = null;
const planList = async () => (planCache ||= (await admin.plans()).plans.filter((p) => !p.archived));
const planOpt = (p) => ({ value: String(p.id), label: `${p.name} · ${p.gb ? p.gb + ' GB' : 'unlimited'} · ${p.days} days · ${n(p.price)} t` });

async function grantForm(u, after) {
  const plans = await planList();
  if (!plans.length) { toast('Make a plan first (More › Plans).', { bad: true }); return; }
  const v = await openForm({ title: 'Give a plan', lead: u.subscription && u.subscription.active ? 'The plan is added on top of what is left (a renewal).' : 'A new period starts now, on every panel.', submit: 'Give plan',
    fields: [{ key: 'planId', label: 'Plan', type: 'select', value: String(plans[0].id), options: plans.map(planOpt) }] });
  if (v) act('user.grant', { userId: u.id, planId: parseInt(v.planId, 10) }, { confirm: `Give "${plans.find((p) => String(p.id) === v.planId).name}" to ${u.label}?`, done: 'Plan given', after });
}

async function numberForm(u, kind, after) {
  const days = kind === 'days';
  const v = await openForm({ title: days ? 'Add days' : 'Add data', lead: 'Changed on every panel at once.', submit: 'Add',
    fields: [{ key: 'x', label: days ? 'Days' : 'GB', type: 'number', required: true, quick: (days ? [7, 30, 90] : [5, 10, 50]).map((x) => ({ value: x, label: `+${x}` })) }] });
  if (v) act(days ? 'user.add_days' : 'user.add_gb', days ? { userId: u.id, days: parseInt(v.x, 10) } : { userId: u.id, gb: parseInt(v.x, 10) }, { done: `${days ? plural(v.x, 'day') : v.x + ' GB'} added`, after });
}

async function walletForm(u, after) {
  const v = await openForm({ title: 'Wallet', lead: `Balance now: ${n(u.wallet)} toman. Use a minus sign to take money out.`, submit: 'Apply',
    fields: [{ key: 'amount', label: 'Amount (toman)', type: 'number', required: true, quick: [{ value: 50000, label: '+50,000' }, { value: 100000, label: '+100,000' }, { value: -50000, label: '−50,000' }] },
      { key: 'note', label: 'Reason', required: true, placeholder: 'e.g. refund for a failed purchase', max: 120 }] });
  if (v) {
    const amount = parseInt(v.amount, 10);
    act('user.wallet', { userId: u.id, amount, note: v.note.trim() }, { confirm: `${amount > 0 ? 'Add' : 'Take'} ${n(Math.abs(amount))} toman ${amount > 0 ? 'to' : 'from'} ${u.label}'s wallet?`, done: 'Wallet changed', after });
  }
}

async function planNameForm(u, after) {
  const plans = await planList();
  const v = await openForm({ title: 'Plan name in the app', lead: 'Only the name the app shows. Data and days stay as they are.', submit: 'Save',
    fields: [{ key: 'planId', label: 'Plan', type: 'select', value: String((u.subscription && u.subscription.plan_id) || 0), options: [{ value: '0', label: '— No plan name —' }, ...plans.map(planOpt)] }] });
  if (v) act('user.plan_name', { userId: u.id, planId: parseInt(v.planId, 10) }, { done: 'Plan name changed', after });
}

async function linkForm(u, after) {
  const [{ panels }, plans] = await Promise.all([admin.panels(), planList()]);
  const live = panels.filter((p) => ['testing', 'rollout', 'active'].includes(p.state));
  if (!live.length) { toast('No panel is ready.', { bad: true }); return; }
  const v = await openForm({ title: 'Link a panel account', lead: 'For someone who already has an account on one of your panels: its usage and days carry over.', submit: 'Link',
    fields: [{ key: 'panelId', label: 'Panel', type: 'select', value: String(live[0].id), options: live.map((p) => ({ value: String(p.id), label: `#${p.id} ${p.label}` })) },
      { key: 'username', label: 'Username on the panel', required: true, max: 64 },
      { key: 'planId', label: 'Plan to count it as', type: 'select', value: '0', options: [{ value: '0', label: 'Keep as on the panel' }, ...plans.map(planOpt)] }] });
  if (v) act('user.link', { userId: u.id, panelId: parseInt(v.panelId, 10), username: v.username.trim(), planId: parseInt(v.planId, 10) || null }, { confirm: `Link ${v.username.trim()} to ${u.label}?`, done: 'Panel account linked', after });
}

async function emailForm(u, after) {
  const v = await openForm({ title: 'Change email', submit: 'Save', fields: [{ key: 'email', label: 'New email', type: 'email', required: true, value: u.email || '' }] });
  if (v) act('user.email', { userId: u.id, email: v.email.trim() }, { done: 'Email changed', after });
}

async function passwordForm(u) {
  await openForm({ title: 'New password', lead: 'Their other phones are signed out.', submit: 'Change', danger: true,
    fields: [{ key: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 8 characters.' }],
    onSubmit: async (v) => { const r = await admin.setPassword(u.id, v.password); if (!r.ok) throw new Error(r.error); toast('Password changed'); } });
}

function SubCard({ u }) {
  const s = u.subscription;
  if (!s) return <div class="card"><div class="cap">Subscription</div><p style={{ margin: '8px 0 0' }} class="muted">No plan yet. Give one, or link an account they already have on a panel.</p></div>;
  const state = subState(s);
  const leftB = s.limit_bytes ? Math.max(0, s.limit_bytes - s.used_bytes) : 0;
  const now = Date.now() / 1000;
  const daysLeft = s.expires_at ? Math.max(0, Math.ceil((s.expires_at - now) / 86400)) : null;
  const period = s.started_at && s.expires_at ? Math.max(1, Math.round((s.expires_at - s.started_at) / 86400)) : null;
  const total = period ? Math.min(30, period) : 30;
  return (
    <div class="card">
      <div class="cap">Data left{s.plan_name ? ` · ${s.plan_name}` : ''}</div>
      <div class="disp">
        <b>{s.limit_bytes ? gb(leftB) : '∞'}</b><span>{s.limit_bytes ? 'GB' : 'data'}</span>
        <span class="of"><Tag tone={state.tone}>{state.label}</Tag></span>
      </div>
      <Pleats left={pleatsLeft(s.used_bytes, s.limit_bytes)} />
      <p class="note" style={{ margin: '8px 0 0', padding: 0 }}>{gb(s.used_bytes)} of {s.limit_bytes ? gb(s.limit_bytes) + ' GB' : 'unlimited'} used, all panels together</p>
      <div class="hr" />
      <div class="cap">Days left</div>
      <div class="disp" style={{ marginBottom: 0 }}>
        <b class="md">{daysLeft == null ? '∞' : n(daysLeft)}</b><span>{period ? `of ${period}` : daysLeft == null ? 'no end date' : 'days'}</span>
        <span class="of">{s.expires_at ? `until ${day(s.expires_at)}` : ''}</span>
      </div>
      {daysLeft != null ? <Dots total={total} left={Math.min(total, Math.round((daysLeft / (period || total)) * total))} /> : null}
      {s.started_at ? <p class="note" style={{ margin: '10px 0 0', padding: 0 }}>Started {day(s.started_at)}</p> : null}
    </div>
  );
}

// One panel account stops being this user's, so it can be linked to another user. Asks whether to switch it off too.
async function unlinkForm(u, a, after) {
  const v = await openForm({ title: 'Unlink panel account', lead: `${a.username} on ${a.panel || 'panel'} #${a.panel_id} stops being ${u.label}'s account. Its usage is no longer counted for them, and you can link it to another user. Usage counted so far stays.`,
    submit: 'Unlink',
    fields: [{ key: 'off', label: 'On the panel', type: 'select', value: '1', options: [{ value: '1', label: 'Switch it off (not deleted)' }, { value: '0', label: 'Leave it as it is' }] }] });
  if (v) act('user.unlink_panel', { userId: u.id, panelId: a.panel_id, off: v.off === '1' }, { confirm: `Unlink ${a.username} from ${u.label}?`, done: 'Panel account unlinked', after });
}

function PanelsLive({ id, u, owner, after }) {
  const st = useLoad(() => admin.userPanels(id), [id]);
  const done = () => { st.reload(); if (after) after(); };
  return (
    <>
      <Section title="On each panel" link="Read again" onLink={st.reload} />
      <Loading st={st} rows={2}>
        {(d) => (d.panels.length ? (
          <List>
            {d.panels.map((a) => (
              <Row icon="layers" title={`${a.panel || 'Panel'} #${a.panel_id}`}
                sub={[a.username, a.used_bytes != null ? `${gb(a.used_bytes)} GB used${a.limit_bytes ? ` of ${gb(a.limit_bytes)}` : ''}` : null,
                  a.expires_at ? `ends ${day(a.expires_at)}` : null, a.online ? 'online now' : a.last_seen ? `seen ${ago(a.last_seen)}` : 'never connected'].filter(Boolean).join(' · ')}
                end={<Tag tone={a.state === 'active' ? 'ok' : ['no_answer', 'missing'].includes(a.state) ? 'warn' : 'bad'}>{ACCOUNT_STATE[a.state] || a.state}</Tag>} wrap
                onClick={owner && u ? () => unlinkForm(u, a, done) : undefined} />
            ))}
          </List>
        ) : <p class="note">No account on any panel yet.</p>)}
      </Loading>
      <p class="note" style={{ marginTop: '8px' }}>Each panel's cap = its own usage + what is left of the plan. When the total reaches the plan, every panel switches off together.{owner ? ' Tap an account to unlink it.' : ''}</p>
    </>
  );
}

export function UserCard({ p, nav }) {
  const st = useLoad(() => admin.user(p.id), [p.id]);
  const owner = nav.role === 'owner';
  return (
    <Loading st={st} hero rows={4}>
      {(u) => {
        const after = st.reload;
        const s = u.subscription;
        return (
          <div class="fade">
            {nav.depth > 1 ? <button type="button" class="iconbtn" style={{ marginLeft: '-10px' }} aria-label="Back" onClick={nav.pop}><Icon name="back" /></button> : null}
            <div class="hello" style={{ margin: '4px 0 14px' }}>
              <Avatar label={u.label} online={u.online} size="lg" seed={u.id} />
              <div class="t">
                <b><bdi>{u.label}</bdi></b>
                <small>{u.online ? 'Online now' : u.last_seen ? `Seen ${ago(u.last_seen)}` : 'Never connected'} · joined {day(u.created_at)} · #{u.id}</small>
              </div>
              {u.blocked ? <Tag tone="bad">Blocked</Tag> : u.deleted ? <Tag>Deleted</Tag> : null}
            </div>
            <SubCard u={u} />
            {owner && !u.deleted ? (
              <>
                <div class="rgrid">
                  <button type="button" onClick={() => grantForm(u, after)}><span class="rb"><Icon name="gift" /></span>{s ? 'Renew' : 'Give plan'}</button>
                  <button type="button" disabled={!s || !s.expires_at} onClick={() => numberForm(u, 'days', after)}><span class="rb"><Icon name="clock" /></span>Add days</button>
                  <button type="button" disabled={!s || !s.limit_bytes} onClick={() => numberForm(u, 'gb', after)}><span class="rb"><Icon name="plus" /></span>Add data</button>
                  <button type="button" onClick={() => walletForm(u, after)}><span class="rb"><Icon name="wallet" /></span>Wallet</button>
                </div>
                {s ? (
                  <div class="rgrid">
                    <button type="button" onClick={() => act('user.pause', { userId: u.id, on: !s.paused }, { done: s.paused ? 'Connected again' : 'Paused on every panel', after })}><span class="rb"><Icon name={s.paused ? 'play' : 'pause'} /></span>{s.paused ? 'Resume' : 'Pause'}</button>
                    <button type="button" onClick={() => act('user.reset_usage', { userId: u.id }, { confirm: `Reset ${u.label}'s usage this period to zero?`, done: 'Usage reset', after })}><span class="rb"><Icon name="refresh" /></span>Reset usage</button>
                    <button type="button" onClick={() => planNameForm(u, after)}><span class="rb"><Icon name="edit" /></span>Plan name</button>
                    <button type="button" onClick={() => linkForm(u, after)}><span class="rb"><Icon name="link" /></span>Link panel</button>
                  </div>
                ) : (
                  <div class="rgrid"><button type="button" onClick={() => linkForm(u, after)}><span class="rb"><Icon name="link" /></span>Link panel</button></div>
                )}
              </>
            ) : null}
            {s ? <PanelsLive id={u.id} u={u} owner={owner} after={after} /> : null}
            <Section title="Account" />
            <List>
              <Row icon="wallet" title="Wallet" sub={`${n(u.wallet)} toman`} onClick={() => nav.push('userWallet', { id: u.id, label: u.label })} chevron />
              <Row icon="receipt" title="Orders" sub={u.order_count ? plural(u.order_count, 'order') + (u.orders[0] ? ` · last ${day(u.orders[0].created_at)}` : '') : 'None yet'} onClick={() => nav.push('userOrders', { id: u.id, label: u.label })} chevron />
              <Row icon="wifi" title="Connection experience" sub="Networks and how each server did" onClick={() => nav.push('userNets', { id: u.id, label: u.label })} chevron />
              <Row icon="message" title="Telegram" sub={u.telegram ? `${u.telegram.username ? '@' + u.telegram.username + ' · ' : ''}id ${u.telegram.id}` : 'Not linked'} />
              <Row icon="mail" title="Email" sub={u.email || (u.login === 'telegram' ? 'None (Telegram only)' : '—')} />
              {u.referral_code ? <Row icon="gift" title="Invite code" sub={u.referral_code} /> : null}
              <Row icon="history" title="History" sub="Every admin change to this user" onClick={() => nav.push('audit', { type: 'user', id: String(u.id) })} chevron />
            </List>
            {u.devices.length ? (
              <>
                <Section title={`Devices · ${u.devices.length}`} />
                <List>
                  {u.devices.map((d) => <Row icon="device" title={d.model || d.device.slice(0, 18)} sub={`Seen ${ago(d.last_seen)}`}
                    end={owner ? <Act kind="ghost" onClick={() => act('user.device_remove', { userId: u.id, deviceId: d.id }, { done: 'Device removed', after })}>Remove</Act> : null} />)}
                </List>
              </>
            ) : null}
            {owner && !u.deleted ? (
              <>
                <Section title="Security" />
                <List>
                  {u.login !== 'telegram' ? <Row icon="key" title="Change password" sub="Signs their other phones out" onClick={() => passwordForm(u)} chevron /> : null}
                  <Row icon="logout" title="Sign out everywhere" sub="Every phone signs in again" onClick={() => act('user.logout_all', { userId: u.id }, { done: 'Signed out everywhere', after })} chevron />
                  <Row icon="mail" title="Change email" onClick={() => emailForm(u, after)} chevron />
                  {u.avatar ? <Row icon="user" title="Reset avatar" sub="Back to the default or Telegram photo" onClick={() => act('user.avatar_reset', { userId: u.id }, { done: 'Avatar reset', after })} chevron /> : null}
                  <Row icon="lock" title={u.blocked ? 'Unblock' : 'Block'} sub={u.blocked ? 'They can sign in again' : 'No sign-in, and every panel switches off'}
                    onClick={() => act('user.block', { userId: u.id, on: !u.blocked }, { done: u.blocked ? 'Unblocked' : 'Blocked', after })} chevron />
                  {u.telegram ? <Row icon="link" title="Unlink Telegram" sub="Frees this Telegram account" danger onClick={() => act('user.unlink_tg', { userId: u.id }, { confirm: `Unlink Telegram from ${u.label}? They can link it again later.`, done: 'Telegram unlinked', after })} chevron /> : null}
                  {s ? <Row icon="close" title="End subscription" sub="Stops it now on every panel" danger onClick={() => act('user.end', { userId: u.id }, { confirm: `End ${u.label}'s subscription now? Every panel account switches off.`, done: 'Subscription ended', after })} chevron /> : null}
                  <Row icon="trash" title="Delete user" sub="Frees the email, Telegram and panel accounts; orders stay" danger onClick={() => act('user.delete', { userId: u.id }, { confirm: `Delete ${u.label}? Their panel accounts are switched off (not deleted) and freed, so you can link them to someone else. Orders and wallet history stay for the books. This cannot be undone.`, done: 'User deleted', after })} chevron />
                </List>
              </>
            ) : null}
          </div>
        );
      }}
    </Loading>
  );
}

export function UserWallet({ p, nav }) {
  const st = useLoad(() => admin.userWallet(p.id), [p.id]);
  return (
    <Page title="Wallet" sub={p.label} nav={nav}>
      <Loading st={st} rows={4}>
        {(d) => (
          <>
            <div class="card"><div class="cap">Balance</div><div class="disp" style={{ marginBottom: 0 }}><b>{n(d.balance)}</b><span>toman</span></div></div>
            <Section title="History" />
            {d.tx.length ? (
              <List>{d.tx.map((t) => <Row icon={t.amount > 0 ? 'plus' : 'minus'} title={`${t.amount > 0 ? '+' : ''}${n(t.amount)} toman`} sub={`${TX_REASON[t.reason] || t.reason} · ${day(t.created_at)}${t.note ? ' · ' + t.note : ''}`} end={<span class="num">{n(t.balance_after)}</span>} />)}</List>
            ) : <p class="note">No transactions.</p>}
          </>
        )}
      </Loading>
    </Page>
  );
}

export function UserOrders({ p, nav }) {
  const st = useLoad(() => admin.userOrders(p.id), [p.id]);
  return (
    <Page title="Orders" sub={p.label} nav={nav}>
      <Loading st={st} rows={4}>
        {(d) => (d.orders.length ? <List>{d.orders.map((o) => <OrderRow o={o} nav={nav} />)}</List> : <EmptyState icon="receipt" title="No orders" />)}
      </Loading>
    </Page>
  );
}

export function UserNets({ p, nav }) {
  const st = useLoad(() => admin.userNets(p.id), [p.id]);
  return (
    <Page title="Connection experience" sub={p.label} nav={nav}>
      <Loading st={st} rows={3}>
        {(d) => (d.nets.length ? d.nets.map((net) => (
          <>
            <Section title={`${net.isp} · ${NET_KIND[net.kind] || net.kind}`} />
            <p class="note" style={{ marginBottom: '8px' }}>Last {ago(net.last_at)} · first {ago(net.first_at)} · {plural(net.reports, 'report')}</p>
            <List>
              {net.servers.length ? net.servers.map((s, i) => (
                <Row icon={i < 3 ? 'bolt' : 'server'} title={s.name}
                  sub={[s.ok_pct != null ? `connects ${s.ok_pct}%` : null, s.ms ? `${s.ms} ms` : null, s.mbps ? `${s.mbps} Mbps` : null].filter(Boolean).join(' · ') || 'speed only'}
                  end={<Tag tone={s.ok_pct == null ? '' : s.ok_pct >= 50 ? 'ok' : 'bad'}>{s.ok_pct == null ? '—' : s.ok_pct >= 50 ? 'Works' : 'Weak'}</Tag>} />
              )) : <Row icon="info" title="No server tests yet" />}
            </List>
          </>
        )) : <EmptyState icon="wifi" title="No reports yet" text="When they open Pleat and the servers get tested (last 30 days), it shows here." />)}
      </Loading>
    </Page>
  );
}
