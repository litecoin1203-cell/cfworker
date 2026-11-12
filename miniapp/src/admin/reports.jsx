// Pleat's automatic health reports (worker/src/health.js), the same as the bot's 🩺 section: open problems per
// priority with a 7-day chart, by server, by user, app / Android versions and phones, and each problem with its
// phones, versions, the last report's details and, for a native crash, what it most likely was. Owner can mark a
// problem handled, mute it for 7 days, and choose what the app sends.
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Tag, Chips, EmptyState, KV } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, ago, plural, day } from './fmt.js';
import { StackColumns } from './charts.jsx';
import { PRIO, PRIO_TONE, MODE, DETAIL, NET, CRASH, detailValue, problemTitle, problemServer } from './labels.js';

const PrioTag = ({ p }) => <Tag tone={PRIO_TONE[p]}>{PRIO[p] || p}</Tag>;
const dayShort = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

function ProblemRows({ list, nav }) {
  if (!list.length) return <EmptyState icon="check" title="No open problems" text="Nothing open in the last 7 days." />;
  return (
    <List>{list.map((r) => <Row icon={r.prio === 1 ? 'warn' : 'pulse'} title={problemTitle(r)} wrap
      sub={[problemServer(r), plural(r.count, 'time'), plural(r.users, 'user'), 'last ' + ago(r.last)].filter(Boolean).join(' · ')}
      end={<PrioTag p={r.prio} />} onClick={() => nav.push('problem', { fp: r.fp })} chevron />)}</List>
  );
}

export function Reports({ nav }) {
  const st = useLoad(() => admin.reports(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="App health" sub="Reports Pleat sends by itself from users' phones · 7 days" nav={nav} right={<button type="button" class="iconbtn" aria-label="Refresh" onClick={st.reload}><Icon name="refresh" /></button>}>
      <Loading st={st} rows={5}>
        {(h) => {
          const tile = (p, icon) => (
            <button type="button" class="tile" onClick={() => nav.push('reportList', { prio: p, title: PRIO[p] })}>
              <span class="cap"><span class={'statdot ' + PRIO_TONE[p]} />{PRIO[p]}</span>
              <b class={h.prio[p].open7 && p === 1 ? 'bad-t' : ''}>{n(h.prio[p].open7)}</b>
              <small>{h.prio[p].open24 ? `${n(h.prio[p].open24)} in 24 h · ` : ''}{plural(h.prio[p].count7, 'time')}</small>
            </button>
          );
          return (
            <>
              <div class="tiles">
                {tile(1)}{tile(2)}{tile(3)}
                <div class="tile"><span class="cap"><Icon name="phone" size={14} />Phones reporting</span><b>{n(h.phones)}</b><small>in 7 days</small></div>
              </div>
              <div class="card" style={{ marginTop: '12px' }}>
                <div class="cap">Reports per day</div>
                <StackColumns cols={h.days.map((x, i) => ({ ...x, label: day(x.day), short: i === h.days.length - 1 ? 'Today' : dayShort(x.day) }))}
                  parts={[{ k: 'p1', label: 'Critical', tone: 'bad' }, { k: 'p2', label: 'Important', tone: 'warn' }, { k: 'p3', label: 'Medium', tone: 'info' }]} />
              </div>
              <Section title="Look by" />
              <List>
                <Row icon="server" title="Server" sub="Which exits have open problems" onClick={() => nav.push('reportServers')} chevron />
                <Row icon="users" title="User" sub="Whose phones report problems" onClick={() => nav.push('reportUsers')} chevron />
                <Row icon="phone" title="Versions and phones" sub="Pleat versions, Android versions, models" onClick={() => nav.push('reportVersions')} chevron />
                <Row icon="history" title="Daily summaries" sub={`${n(h.prio[4].open7)} in 7 days`} onClick={() => nav.push('reportList', { prio: 4, title: PRIO[4] })} chevron />
              </List>
              <Section title="What the app sends" />
              {owner ? <Chips items={h.modes.map((m) => ({ k: m, label: MODE[m] }))} value={h.mode}
                onChange={(m) => act('health.mode', { mode: m }, { done: `The app sends: ${MODE[m].toLowerCase()}`, after: st.reload })} />
                : <p class="note">{MODE[h.mode]}</p>}
              <p class="note" style={{ marginTop: '8px' }}>Critical problems also reach your Telegram the moment they happen. Reports never carry links, keys or account ids.</p>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

export function ReportList({ p, nav }) {
  const q = p.server ? { server: p.server } : p.user ? { user: p.user } : { prio: p.prio };
  const st = useLoad(() => admin.reportProblems(q), [p.server, p.user, p.prio]);
  return (
    <Loading st={st} rows={5}>
      {(d) => (
        <Page title={d.filter === 'prio' ? PRIO[d.prio] : d.name || p.title || (d.filter === 'server' ? 'Server' : `User #${d.user}`)}
          sub={d.filter === 'prio' ? 'Open problems, last 7 days' : d.filter === 'server' ? 'Open problems on this exit' : 'Open problems from this user'} nav={nav}>
          <ProblemRows list={d.problems} nav={nav} />
          {d.filter === 'server' ? <div style={{ marginTop: '12px' }}><List><Row icon="wifi" title="This server on every carrier" onClick={() => nav.push('netServer', { key: d.server, name: d.name })} chevron /></List></div> : null}
          {d.filter === 'user' && d.name ? <div style={{ marginTop: '12px' }}><List><Row icon="user" title="User card" onClick={() => nav.push('user', { id: d.user })} chevron /></List></div> : null}
        </Page>
      )}
    </Loading>
  );
}

export function ReportServers({ nav }) {
  const st = useLoad(() => admin.reportServers(), []);
  return (
    <Page title="By server" sub="Exits with open problems, worst first" nav={nav}>
      <Loading st={st} rows={5}>
        {(d) => (d.servers.length ? (
          <List>{d.servers.map((s) => <Row icon="server" title={s.name} sub={`${plural(s.problems, 'problem')} · ${plural(s.count, 'time')} · ${plural(s.users, 'user')}`}
            end={<PrioTag p={s.top} />} onClick={() => nav.push('reportList', { server: s.key, title: s.name })} chevron />)}</List>
        ) : <EmptyState icon="check" title="No server has open problems" />)}
      </Loading>
    </Page>
  );
}

export function ReportUsers({ nav }) {
  const st = useLoad(() => admin.reportUsers(), []);
  return (
    <Page title="By user" sub="Phones with open problems, worst first" nav={nav}>
      <Loading st={st} rows={5}>
        {(d) => (d.users.length ? (
          <List>{d.users.map((u) => <Row icon="user" title={<bdi>{u.deleted ? `#${u.id} (deleted)` : u.name}</bdi>}
            sub={[plural(u.problems, 'problem'), plural(u.count, 'time'), u.app ? 'Pleat ' + u.app : null, u.model].filter(Boolean).join(' · ')}
            end={<PrioTag p={u.top} />} onClick={() => nav.push('reportList', { user: u.id, title: u.name })} chevron />)}</List>
        ) : <EmptyState icon="check" title="No user reports problems" />)}
      </Loading>
    </Page>
  );
}

function Shares({ rows, total }) {
  if (!rows.length) return <p class="note">—</p>;
  return (
    <div class="list">{rows.map((r) => (
      <div class="share">
        <div class="share-top"><b>{r.name}</b><small>{plural(r.users, 'user')}{r.critical ? ` · ${n(r.critical)} critical` : ''}</small></div>
        <div class="share-bar"><i class={r.critical ? 's-bad' : 's-blue'} style={{ width: `${Math.max(3, (100 * r.users) / (total || 1))}%` }} /></div>
      </div>
    ))}</div>
  );
}

export function ReportVersions({ nav }) {
  const st = useLoad(() => admin.reportVersions(), []);
  return (
    <Page title="Versions and phones" sub="Who reported in 7 days; red = had critical problems" nav={nav}>
      <Loading st={st} rows={6}>
        {(d) => {
          const tot = (rows) => Math.max(1, ...rows.map((r) => r.users));
          return (
            <>
              <Section title="Pleat version" /><Shares rows={d.apps} total={tot(d.apps)} />
              <Section title="Android" /><Shares rows={d.os} total={tot(d.os)} />
              <Section title="Phone model" /><Shares rows={d.models} total={tot(d.models)} />
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

const STATE = { open: ['Open', 'warn'], muted: ['Muted', ''], resolved: ['Handled', 'ok'] };

export function Problem({ p, nav }) {
  const st = useLoad(() => admin.reportProblem(p.fp), [p.fp]);
  const owner = nav.role === 'owner';
  return (
    <Loading st={st} rows={6}>
      {(e) => {
        if (e.gone) return <Page title="Problem" nav={nav}><EmptyState icon="check" title="Gone" text="This problem is no longer in the last 7 days." /></Page>;
        const [stLabel, stTone] = STATE[e.state] || [e.state, ''];
        const detail = Object.entries(e.detail || {});
        return (
          <Page title={problemTitle(e)} sub={problemServer(e) || 'Pleat health report'} nav={nav}>
            <div class="card">
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}><PrioTag p={e.prio} /><Tag tone={stTone}>{stLabel}</Tag></div>
              <div class="strip" style={{ boxShadow: 'none', margin: '12px -8px 0' }}>
                <div><b>{n(e.total)}</b><span>times</span></div>
                <div><b>{n(e.users.length)}</b><span>{e.users.length === 1 ? 'user' : 'users'}</span></div>
                <div><b style={{ fontSize: '17px' }}>{ago(e.last)}</b><span>last · first {ago(e.first)}</span></div>
              </div>
            </div>
            {e.crash && CRASH[e.crash] ? (
              <div class="banner warn" style={{ marginTop: '12px' }}><Icon name="bug" /><span><b>Most likely</b>{CRASH[e.crash]}</span></div>
            ) : null}
            {owner && e.state !== 'resolved' ? (
              <div class="btns" style={{ marginTop: '12px' }}>
                {e.state === 'open' ? <>
                  <button type="button" class="btn primary" onClick={() => act('health.resolve', { fp: e.fp }, { done: 'Marked handled. It opens again if it happens again.', after: st.reload })}>Handled</button>
                  <button type="button" class="btn ghost" onClick={() => act('health.mute', { fp: e.fp, on: true }, { done: 'Muted for 7 days', after: st.reload })}>Mute 7 days</button>
                </> : <button type="button" class="btn ghost" onClick={() => act('health.mute', { fp: e.fp, on: false }, { done: 'Shown again', after: st.reload })}>Show again</button>}
              </div>
            ) : null}
            <Section title="Who and where" />
            <div class="card tight">
              <KV k="Pleat">{e.apps.join(', ') || '—'}</KV>
              <KV k="Android">{e.os.join(', ') || '—'}</KV>
              <KV k="Phone">{e.models.join(', ') || '—'}</KV>
              <KV k="Network">{[e.isps.join(', '), e.nets.length ? `(${e.nets.map((x) => NET[x] || x).join(', ')})` : ''].filter(Boolean).join(' ') || '—'}</KV>
            </div>
            <Section title={`Users · ${e.users.length}`} />
            <List>{e.users.slice(0, 10).map((u) => <Row icon="user" title={<bdi>{u.name || `#${u.id} (deleted)`}</bdi>} onClick={u.name ? () => nav.push('user', { id: u.id }) : undefined} chevron={!!u.name} />)}</List>
            {detail.length ? (
              <>
                <Section title="Last report" />
                <div class="card tight det">{detail.map(([k, v]) => <KV k={DETAIL[k] || k}>{detailValue(k, v, e.detail, e.names || {})}</KV>)}</div>
              </>
            ) : null}
            {e.exit_key ? <div style={{ marginTop: '12px' }}><List><Row icon="server" title="Every problem on this server" onClick={() => nav.push('reportList', { server: e.exit_key, title: e.exit_name })} chevron /></List></div> : null}
          </Page>
        );
      }}
    </Loading>
  );
}
