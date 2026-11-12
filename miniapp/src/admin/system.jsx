// Reach and reports, and the system: broadcasts, stats, backup, health, the admin log with undo, admins, every setting.
import { useState } from 'preact/hooks';
import { admin } from './api.js';
import { SyncActs } from './monitor.jsx';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Chips, Search, Tag, Act, Button, EmptyState, KV, openForm, toast } from '../ui.jsx';
import { n, short, ago, day, dayShort, plural, METHOD, ROLE, AUDIENCE, BC_STATUS, settingLabel, actionLabel, englishSummary } from './fmt.js';

const BC_TONE = { draft: '', sending: 'info', done: 'ok', stopped: 'warn' };

// ---------------- broadcasts ----------------
async function newBroadcast(audiences, nav, after) {
  await openForm({
    title: 'New broadcast', submit: 'Save draft',
    lead: 'It goes to Telegram users who started the bot. You can read it again before it is sent.',
    fields: [
      { key: 'audience', label: 'Send to', type: 'select', value: 'all', options: Object.keys(AUDIENCE).map((k) => ({ value: k, label: `${AUDIENCE[k]} · ${n(audiences[k] || 0)}` })) },
      { key: 'text', label: 'Message', type: 'textarea', required: true, max: 3500, placeholder: 'New servers in Germany are live…' },
    ],
    onSubmit: async (v) => {
      const r = await admin.action('broadcast.create', { audience: v.audience, text: v.text.trim() });
      if (!r.ok) throw new Error(r.error);
      after();
      if (r.target_id) nav.push('broadcast', { id: r.target_id });
    },
  });
}

export function Broadcasts({ nav }) {
  const st = useLoad(() => admin.broadcasts(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Broadcast" sub="A message to your Telegram users" nav={nav}>
      <Loading st={st} rows={4}>
        {(d) => (
          <>
            <div class="strip">
              {['all', 'active', 'expired'].map((k) => <button type="button"><b>{short(d.audiences[k] || 0)}</b><span>{AUDIENCE[k]}</span></button>)}
            </div>
            {owner ? <div style={{ marginTop: '14px' }}><Button onClick={() => newBroadcast(d.audiences, nav, st.reload)}>Write a message</Button></div> : null}
            <Section title="Recent" />
            {d.broadcasts.length ? (
              <List>{d.broadcasts.map((b) => (
                <Row icon="megaphone" title={String(b.preview || '').split('\n')[0] || `#${b.id}`} sub={`${AUDIENCE[b.audience] || b.audience} · ${n(b.sent)} sent · ${ago(b.created_at)}`}
                  end={<Tag tone={BC_TONE[b.status]}>{BC_STATUS[b.status] || b.status}</Tag>} onClick={() => nav.push('broadcast', { id: b.id })} />
              ))}</List>
            ) : <EmptyState icon="megaphone" title="No broadcasts yet" text="Write one to tell everyone about new servers or a sale." />}
          </>
        )}
      </Loading>
    </Page>
  );
}

export function BroadcastDetail({ p, nav }) {
  const st = useLoad(() => admin.broadcast(p.id), [p.id]);
  const owner = nav.role === 'owner';
  return (
    <Page title={`Broadcast #${p.id}`} nav={nav}>
      <Loading st={st} rows={3}>
        {(b) => (
          <>
            <div class="card">
              <div class="cap">{AUDIENCE[b.audience] || b.audience}</div>
              <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 12px' }} dir="auto">{b.text}</p>
              <KV k="Status"><Tag tone={BC_TONE[b.status]}>{BC_STATUS[b.status] || b.status}</Tag></KV>
              {b.audience_now != null ? <KV k="Will reach">{plural(b.audience_now, 'person', 'people')}</KV> : null}
              <KV k="Sent">{n(b.sent)}</KV>
              {b.failed ? <KV k="Failed">{n(b.failed)}</KV> : null}
              {b.blocked ? <KV k="Blocked the bot">{n(b.blocked)}</KV> : null}
              <KV k="Written">{day(b.created_at)} · {ago(b.created_at)}</KV>
            </div>
            {owner && b.status === 'draft' ? (
              <div class="btns" style={{ marginTop: '12px' }}>
                <Button onClick={() => act('broadcast.start', { id: b.id }, { confirm: `Send this to about ${plural(b.audience_now || 0, 'person', 'people')}? It cannot be taken back once sent.`, done: 'Sending started', after: st.reload })}>Send now</Button>
              </div>
            ) : null}
            {owner && b.status === 'sending' ? (
              <div class="btns" style={{ marginTop: '12px' }}>
                <Button kind="ghost" onClick={() => act('broadcast.stop', { id: b.id }, { done: 'Stopped', after: st.reload })}>Stop sending</Button>
                <Button kind="soft" onClick={st.reload}>Refresh</Button>
              </div>
            ) : null}
            {b.status === 'sending' ? <p class="note" style={{ marginTop: '10px' }}>About 25 people every 2 minutes. Pull to refresh to see progress.</p> : null}
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- stats ----------------
const DAYS = [{ k: 1, label: 'Today' }, { k: 7, label: '7 days' }, { k: 30, label: '30 days' }];

export function Stats({ p, nav }) {
  const [days, setDays] = useState((p && p.days) || 7);
  const st = useLoad(() => admin.stats(days), [days]);
  return (
    <Page title="Stats" nav={nav}>
      <Chips items={DAYS} value={days} onChange={setDays} />
      <Loading st={st} rows={4}>
        {(d) => {
          const max = Math.max(1, ...d.bars.map((b) => b.toman));
          return (
            <>
              <div class="card">
                <div class="cap">Money in</div>
                <div class="disp"><b>{short(d.toman)}</b><span>toman</span></div>
                <p class="note">{plural(d.sales, 'paid order')} · wallet purchases left out</p>
                {d.bars.length > 1 ? (
                  <div class="bars" aria-label="Money in per day">
                    {d.bars.map((b) => <i class={b.toman ? '' : 'z'} style={{ height: `${Math.max(2, (b.toman / max) * 100)}%` }} title={`${dayShort(b.day)}: ${n(b.toman)} toman`} />)}
                  </div>
                ) : null}
              </div>
              <div class="strip">
                <button type="button"><b>{n(d.signups)}</b><span>Sign-ups</span></button>
                <button type="button"><b>{n(d.renewals)}</b><span>Renewals</span></button>
                <button type="button"><b>{n(d.active)}</b><span>Active now</span></button>
              </div>
              <Section title="By method" />
              {d.methods.length ? (
                <List>{d.methods.map((m) => <Row icon={m.method === 'coin' ? 'coin' : m.method === 'wallet' ? 'wallet' : 'card'} title={METHOD[m.method] || m.method} sub={plural(m.orders, 'order')} end={<b>{short(m.toman)}</b>} />)}</List>
              ) : <EmptyState icon="chart" title="No sales in this time" />}
              <Section title="Best plans" />
              {d.top.length ? (
                <List>{d.top.map((t, i) => <Row icon="box" title={`${i + 1}. ${t.name}`} sub={`${plural(t.orders, 'sale')} · ${n(t.toman)} toman`} onClick={t.plan_id ? () => nav.push('plan', { id: t.plan_id }) : undefined} chevron={!!t.plan_id} />)}</List>
              ) : <EmptyState icon="box" title="No plan sold yet" />}
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// ---------------- system ----------------
export function System({ nav }) {
  const owner = nav.role === 'owner';
  const [busy, setBusy] = useState(false);
  const backup = async () => {
    setBusy(true);
    try { await admin.backup(); toast('Backup sent to your Telegram'); } catch (e) { toast(e.message, { bad: true }); }
    setBusy(false);
  };
  return (
    <Page title="System" nav={nav}>
      {owner ? (
        <div class="card">
          <div class="cap">Backup</div>
          <p class="note" style={{ margin: '6px 0 12px' }}>The whole database as one file, sent to your Telegram chat. A backup is also sent every day.</p>
          <Button busy={busy} onClick={backup}>Send a backup now</Button>
        </div>
      ) : null}
      <Section title="More" />
      <List>
        <Row icon="pulse" title="System health" sub="Webhook, panel sync, sync now" onClick={() => nav.push('health')} chevron />
        <Row icon="cloud" title="Cloudflare" sub="Free plan use, errors, CPU, deploys" onClick={() => nav.push('cloud')} chevron />
        <Row icon="heart" title="App health" sub="Reports from users' phones" onClick={() => nav.push('reports')} chevron />
        <Row icon="history" title="Admin log" sub="Every change, with undo for 10 minutes" onClick={() => nav.push('audit')} chevron />
        {owner ? <Row icon="shield" title="Admins" sub="Support and viewer roles" onClick={() => nav.push('admins')} chevron /> : null}
        {owner ? <Row icon="settings" title="All settings" sub="Every value, with history" onClick={() => nav.push('settings')} chevron /> : null}
      </List>
    </Page>
  );
}

const HOOK = { ok: ['Connected', 'ok'], missing: ['Not set', 'bad'], other: ['Points elsewhere', 'bad'], no_answer: ['Telegram did not answer', 'warn'] };

export function Health({ nav }) {
  const st = useLoad(() => admin.health(), []);
  return (
    <Page title="System health" nav={nav} right={<Act onClick={() => st.reload()}>Refresh</Act>}>
      <Loading st={st} rows={4}>
        {(h) => {
          const hk = HOOK[h.webhook.state] || [h.webhook.state, ''];
          const q = h.queue;
          return (
            <>
              <Section title="Telegram" />
              <List>
                <Row icon="link" title="Bot webhook" sub={h.webhook.pending ? `${plural(h.webhook.pending, 'update')} waiting` : 'Nothing waiting'} end={<Tag tone={hk[1]}>{hk[0]}</Tag>} />
                {h.webhook.last_error ? <Row icon="warn" title="Last error" sub={`${h.webhook.last_error}${h.webhook.last_error_at ? ' · ' + ago(h.webhook.last_error_at) : ''}`} wrap /> : null}
              </List>
              <Section title="Panel sync" />
              <List>
                <Row icon="refresh" title="Last sync run" sub={h.sync.last_run ? ago(h.sync.last_run) : 'Never'} end={<Tag tone={h.sync.late ? 'bad' : 'ok'}>{h.sync.late ? 'Late' : 'On time'}</Tag>} />
                <Row icon="layers" title="Accounts waiting to sync" sub={q.stuck ? `${n(q.stuck)} stuck after 3 tries` : 'None stuck'} end={<b>{n(q.dirty)}</b>} />
                <Row icon="warn" title="Account errors" end={<Tag tone={q.account_errors ? 'warn' : 'ok'}>{n(q.account_errors)}</Tag>} />
                <Row icon="server" title="Panels refusing new accounts" onClick={q.panel_errors ? () => nav.push('panels') : undefined} chevron={!!q.panel_errors}
                  end={<Tag tone={q.panel_errors ? 'bad' : 'ok'}>{n(q.panel_errors)}</Tag>} />
              </List>
              <SyncActs q={q} owner={nav.role === 'owner'} after={st.reload} />
              {nav.role === 'owner' ? <p class="note" style={{ marginTop: '8px' }}>Sync now runs one panel sync right away (once a minute). Retry puts accounts that failed 3 times back at the front of the queue.</p> : null}
              <Section title="Broadcasts" />
              <List><Row icon="megaphone" title="Sending now" end={<b>{n(h.broadcasts_sending)}</b>} onClick={() => nav.push('broadcasts')} chevron /></List>
              <Section title="Monitoring" />
              <List>
                <Row icon="cloud" title="Cloudflare" sub="Free plan use, errors, CPU, deploys" onClick={() => nav.push('cloud')} chevron />
                <Row icon="heart" title="App health" sub="Reports from users' phones" onClick={() => nav.push('reports')} chevron />
              </List>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// ---------------- the admin log ----------------
export function Audit({ p, nav }) {
  const type = p && p.type, id = p && p.id;
  const st = useLoad(() => admin.audit({ type, id }), [type, id]);
  const [pages, setPages] = useState([]);
  const all = st.data ? [st.data, ...pages] : [];
  const last = all[all.length - 1];
  const more = async () => {
    try { const pg = await admin.audit({ type, id, before: last.next }); setPages((x) => [...x, pg]); } catch (e) { toast(e.message, { bad: true }); }
  };
  const reload = () => { setPages([]); st.reload(); };
  const undo = async (row) => {
    try { const r = await admin.undo(row.id); if (r.ok) toast('Undone'); else toast(r.error, { bad: true }); } catch (e) { toast(e.message, { bad: true }); }
    reload();
  };
  const who = (a, owner) => (a === owner ? 'Owner' : a ? `Admin ${a}` : 'System');
  return (
    <Page title={type ? 'History' : 'Admin log'} sub={type ? `${type} ${id}` : 'Every change, with undo for 10 minutes'} nav={nav}>
      <Loading st={st} rows={6}>
        {(d) => (d.log.length ? (
          <>
            <List>{all.flatMap((pg) => pg.log).map((r) => (
              <Row icon={r.undone ? 'undo' : 'history'} title={actionLabel(r.action)} wrap
                sub={`${englishSummary(r.summary) ? englishSummary(r.summary) + ' · ' : ''}${r.target_type ? `${r.target_type} ${r.target_id || ''} · ` : ''}${who(r.admin, d.owner)} · ${ago(r.at)}`}
                end={r.undone ? <Tag>Undone</Tag> : r.can_undo && nav.role !== 'viewer' ? <Act kind="ghost" onClick={() => undo(r)}>Undo</Act> : null} />
            ))}</List>
            {last && last.more ? <div style={{ marginTop: '12px' }}><Button kind="soft" onClick={more}>Show older</Button></div> : null}
          </>
        ) : <EmptyState icon="history" title="Nothing here yet" text="Changes made from the bot or this app show up here." />)}
      </Loading>
    </Page>
  );
}

// ---------------- admins (owner) ----------------
async function addAdmin(after, tgId = '', role = 'support') {
  await openForm({
    title: tgId ? 'Change role' : 'Add an admin', submit: 'Save',
    lead: 'Support sees receipts and orders and can approve them. Viewer sees everything but changes nothing.',
    fields: [
      { key: 'tgId', label: 'Numeric Telegram ID', type: 'number', value: tgId, required: true, hint: 'They can get it from @userinfobot. 5 to 15 digits.' },
      { key: 'role', label: 'Role', type: 'select', value: role, options: [{ value: 'support', label: 'Support' }, { value: 'viewer', label: 'Viewer' }] },
    ],
    onSubmit: async (v) => {
      const r = await admin.action('admin.add', { tgId: v.tgId.trim(), role: v.role });
      if (!r.ok) throw new Error(r.error);
      toast('Saved'); after();
    },
  });
}

export function Admins({ nav }) {
  const st = useLoad(() => admin.admins(), []);
  return (
    <Page title="Admins" nav={nav} right={<Act onClick={() => addAdmin(st.reload)}>Add</Act>}>
      <Loading st={st} rows={3}>
        {(d) => (
          <>
            <List>
              <Row icon="shield" title={`${d.owner}`} sub="Owner · from the server settings, always has every right" end={<Tag tone="info">Owner</Tag>} />
              {d.admins.map((a) => (
                <Row icon="user" title={a.tg_id} sub={`${ROLE[a.role] || a.role} · added ${ago(a.added_at)}`} onClick={() => addAdmin(st.reload, a.tg_id, a.role)}
                  end={<Act kind="danger" onClick={() => act('admin.remove', { tgId: a.tg_id }, { confirm: `Remove ${a.tg_id} as an admin?`, done: 'Removed', after: st.reload })}>Remove</Act>} />
              ))}
            </List>
            {!d.admins.length ? <p class="note" style={{ marginTop: '10px' }}>Only you for now. Add a support admin to share the receipts.</p> : null}
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- every setting (owner) ----------------
export function Settings({ nav }) {
  const st = useLoad(() => admin.settings(), []);
  const [q, setQ] = useState('');
  const edit = async (s) => {
    if (s.list) { nav.push('app'); return; }
    const label = settingLabel(s.key);
    const v = await openForm({
      title: label, submit: 'Save', lead: s.key,
      fields: [{ key: 'val', label, type: s.secret ? 'password' : s.value.length > 60 || s.key === 'announcement' ? 'textarea' : 'text', value: s.secret ? '' : s.value,
        required: !!s.secret, hint: s.secret ? 'Hidden. Type a new value to replace it.' : 'Leave empty to use the default.', max: 2000 }],
    });
    if (v) act('setting.set', { key: s.key, val: v.val }, { done: `${label} saved`, after: st.reload });
  };
  return (
    <Page title="All settings" sub="Every value, with history" nav={nav}>
      <Loading st={st} rows={8}>
        {(d) => {
          const k = q.trim().toLowerCase();
          const rows = d.settings.filter((s) => !k || s.key.includes(k) || settingLabel(s.key).toLowerCase().includes(k));
          return (
            <>
              <Search placeholder="Find a setting" value={q} onInput={setQ} />
              <List>{rows.map((s) => (
                <Row icon={s.secret ? 'lock' : s.list ? 'layers' : 'settings'} title={settingLabel(s.key)}
                  sub={s.list ? 'Edit in Pleat app' : s.value ? String(s.value).split('\n')[0].slice(0, 60) : 'Default'}
                  end={<Act kind="ghost" onClick={() => nav.push('audit', { type: 'setting', id: s.key })}>History</Act>} onClick={() => edit(s)} />
              ))}</List>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}
