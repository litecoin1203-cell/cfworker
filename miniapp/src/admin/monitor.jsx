// ☁️ Cloudflare monitoring, the visual way: how much of the Free plan's daily allowance is used (rings with the
// end-of-day projection), the last 24 hours hour by hour, CPU against the 10 ms cap, how requests ended, what the
// Free plan can carry, 7 days side by side, the Worker's own error log, the costliest queries and deploys.
// Same numbers as the bot's ☁️ section (worker/src/cfmon.js *Data), never the token.
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Tag, Button, EmptyState, Toggle, toast } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, short, ago, plural } from './fmt.js';
import { Ring, HourBars, CpuLine, StackBar, Gauge, DayColumns, ShareRow } from './charts.jsx';
import { cfError, CF_STATUS, CF_STATUS_TONE, CAPACITY_BY, RUN_STATE, RUN_TONE, pctText, quotaTone, bytes, span, clock } from './labels.js';
import { webApp } from '../tg.js';

const statusTone = (k) => CF_STATUS_TONE[k] || 'bad';
const statusParts = (st) => Object.entries(st || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: CF_STATUS[k] || k, value: v, tone: statusTone(k) }));
const dayShort = (ymd) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayLong = (ymd) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function openLink(url) {
  const w = webApp();
  try { if (w && w.openLink) { w.openLink(url); return; } } catch (e) { /* older clients */ }
  window.open(url, '_blank', 'noopener');
}

function Banner({ tone = '', icon = 'info', title, children, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} class={'banner ' + tone} style={onClick ? { width: '100%', border: 0, textAlign: 'left', color: 'var(--ink)', cursor: 'pointer' } : null} onClick={onClick}>
      <Icon name={icon} />
      <span style={{ flex: 1 }}>{title ? <b>{title}</b> : null}{children}</span>
      {onClick ? <Icon name="chevron" size={20} /> : null}
    </Tag>
  );
}

function Tile({ label, icon, value, sub, tone, onClick }) {
  const T = onClick ? 'button' : 'div';
  return (
    <T type={onClick ? 'button' : undefined} class="tile" onClick={onClick}>
      <span class="cap">{icon ? <Icon name={icon} size={14} /> : null}{label}</span>
      <b class={tone ? tone + '-t' : ''}>{value}</b>
      {sub ? <small>{sub}</small> : null}
    </T>
  );
}

const Refresh = ({ st }) => <button type="button" class="iconbtn" aria-label="Refresh" onClick={st.reload}><Icon name="refresh" /></button>;

// ---------------- overview ----------------
export function Cloud({ nav }) {
  const st = useLoad(() => admin.cf(), []);
  const owner = nav.role === 'owner';
  return (
    <Loading st={st} hero rows={4}>
      {(d) => {
        const w = d.workers, db = d.d1;
        const reset = span(d.reset_at - d.now);
        const errRate = w.last24 && w.last24.requests ? (100 * w.last24.errors) / w.last24.requests : 0;
        const cpuTone = w.last24 ? (w.last24.cpu_p99 >= w.last24.cpu_cap ? 'bad' : w.last24.cpu_p99 >= w.last24.cpu_cap * 0.7 ? 'warn' : '') : '';
        const growth = d.db_size.week_growth;
        return (
          <Page title="Cloudflare" sub={`Free plan today · resets in ${reset} (00:00 UTC)`} nav={nav} right={<Refresh st={st} />}>
            {!d.token ? (
              <div style={{ marginBottom: '12px' }}>
                <Banner tone="warn" icon="key" title="Connect Cloudflare's numbers" onClick={() => nav.push('cloudToken')}>
                  A read-only token shows today's quota use, errors and CPU. Until then you see what the Worker knows by itself.
                </Banner>
              </div>
            ) : null}
            <div class="rings">
              {w.error ? <ErrRing label="Worker requests" e={w.error} /> : <Ring label="Worker requests" pct={w.requests.pct} proj={w.requests.proj != null ? (100 * w.requests.proj) / w.requests.limit : null} value={`${short(w.requests.used)} of ${short(w.requests.limit)}`} />}
              {db.error ? <ErrRing label="D1 rows written" e={db.error} /> : <Ring label="D1 rows written" pct={db.rows_written.pct} proj={db.rows_written.proj != null ? (100 * db.rows_written.proj) / db.rows_written.limit : null} value={`${short(db.rows_written.used)} of ${short(db.rows_written.limit)}`} />}
              {db.error ? <ErrRing label="D1 rows read" e={db.error} /> : <Ring label="D1 rows read" pct={db.rows_read.pct} proj={db.rows_read.proj != null ? (100 * db.rows_read.proj) / db.rows_read.limit : null} value={`${short(db.rows_read.used)} of ${short(db.rows_read.limit)}`} />}
              {d.db_size.used ? <Ring label="Database size" pct={(100 * d.db_size.used) / d.db_size.limit} value={`${bytes(d.db_size.used)} of ${bytes(d.db_size.limit)}`} />
                : <ErrRing label="Database size" text="Not known yet" />}
            </div>
            {growth != null ? <p class="note" style={{ marginTop: '8px' }}>Database {growth >= 0 ? 'grew' : 'shrank'} {bytes(Math.abs(growth))} in 7 days.{w.scripts > 1 ? ` Requests count the whole account; this Worker made ${short(w.mine_today)} of them.` : ''}</p>
              : w.scripts > 1 ? <p class="note" style={{ marginTop: '8px' }}>Requests count the whole account; this Worker made {short(w.mine_today)} of them.</p> : null}
            <p class="note" style={{ marginTop: '6px' }}>The pale part of each ring is where today's pace ends the day.</p>

            {!w.error ? (
              <>
                <Section title="Last 24 hours" />
                <div class="tiles">
                  <Tile icon="pulse" label="Requests" value={short(w.last24.requests)} sub={`${Number(w.last24.sub_per_req || 0).toFixed(1)} subrequests each`} />
                  <Tile icon="warn" label="Error rate" value={errRate < 1 && errRate > 0 ? errRate.toFixed(2) + '%' : errRate.toFixed(1) + '%'} tone={errRate >= 5 ? 'bad' : errRate >= 1 ? 'warn' : ''} sub={`${n(w.last24.errors)} errors`} onClick={() => nav.push('cloudErrors')} />
                  <Tile icon="bolt" label="CPU (worst hour)" value={`${w.last24.cpu_p99.toFixed(1)} ms`} tone={cpuTone} sub={`median ${w.last24.cpu_p50.toFixed(1)} ms · cap ${w.last24.cpu_cap} ms`} />
                  <Tile icon="shield" label="Rejected (CPU cap)" value={n(w.last24.cpu_over)} tone={w.last24.cpu_over ? 'bad' : ''} sub={w.last24.cpu_over ? 'users got an error' : 'none'} />
                </div>
                <div class="card" style={{ marginTop: '12px' }}>
                  <div class="cap">Requests per hour</div>
                  <HourBars hours={w.hours} fmtTime={clock} />
                </div>
                <div class="card" style={{ marginTop: '12px' }}>
                  <div class="cap">CPU against the Free plan cap</div>
                  <CpuLine hours={w.hours} cap={w.last24.cpu_cap} fmtTime={clock} />
                </div>
                {Object.keys(w.last24.status || {}).length ? (
                  <div class="card" style={{ marginTop: '12px' }}>
                    <div class="cap" style={{ marginBottom: '10px' }}>How requests ended</div>
                    <StackBar parts={statusParts(w.last24.status)} />
                  </div>
                ) : null}
              </>
            ) : null}

            {d.capacity ? (
              <>
                <Section title="What the Free plan carries" />
                <div class="card">
                  <Gauge value={d.capacity.active} max={d.capacity.users} label={`≈ ${n(d.capacity.users)} users`} sub={`${n(d.capacity.active)} active today`} />
                  <p class="note" style={{ textAlign: 'center', marginTop: '6px' }}>At today's pattern the Free plan carries about {n(d.capacity.users)} active users. {CAPACITY_BY[d.capacity.by] || d.capacity.by} run out first.</p>
                </div>
              </>
            ) : null}

            <Section title="The Worker itself" />
            <List>
              <Row icon="bug" title="Errors it logged" sub={d.own_errors.kinds ? `${plural(d.own_errors.kinds, 'kind')} in 24 h · ${plural(d.own_errors.count, 'time')} since first seen` : 'Nothing in 24 hours'}
                end={<Tag tone={d.own_errors.kinds ? 'bad' : 'ok'}>{d.own_errors.kinds ? n(d.own_errors.kinds) : 'Clean'}</Tag>} onClick={() => nav.push('cloudErrors')} chevron />
              <Row icon="clock" title="Every-minute cron" sub={d.cron_at ? `Last run ${ago(d.cron_at, d.now)}` : 'Has not run yet'}
                end={<Tag tone={!d.cron_at || d.now - d.cron_at > 300 ? 'bad' : 'ok'}>{!d.cron_at ? 'Never' : d.now - d.cron_at > 300 ? 'Late' : 'On time'}</Tag>} />
              <Row icon="bell" title="Hourly alerts" sub="A Telegram message before a daily limit is hit, or on a new error"
                end={owner ? <Toggle on={d.alerts} label="Hourly alerts" onChange={(v) => act('setting.set', { key: 'cf_alerts', val: v ? '1' : '0' }, { done: v ? 'Alerts on' : 'Alerts off', after: st.reload })} /> : <Tag tone={d.alerts ? 'ok' : ''}>{d.alerts ? 'On' : 'Off'}</Tag>} />
            </List>

            <Section title="More" />
            <List>
              <Row icon="chart" title="Last 7 days" sub="Each day against the daily caps" onClick={() => nav.push('cloudDays')} chevron />
              <Row icon="filter" title="Costliest queries" sub="Where D1 reads and writes go" onClick={() => nav.push('cloudQueries')} chevron />
              <Row icon="rocket" title="Deploys and builds" sub="What is live, what is merged but not deployed" onClick={() => nav.push('cloudDeploys')} chevron />
              <Row icon="key" title={d.token ? 'Token and access' : 'Set up the token'} sub={d.token ? 'Check that Cloudflare accepts it' : 'One read-only token, a few steps'} onClick={() => nav.push('cloudToken')} chevron />
              <Row icon="pulse" title="System health" sub="Webhook, panel sync, sync now" onClick={() => nav.push('health')} chevron />
            </List>
            <p class="note" style={{ marginTop: '10px' }}>Updated {clock(d.now)}. Cloudflare's numbers can lag a few minutes.</p>
          </Page>
        );
      }}
    </Loading>
  );
}

function ErrRing({ label, e, text }) {
  return (
    <div class="ring">
      <svg viewBox="0 0 100 100" width="104" height="104" aria-hidden="true"><circle class="trk" cx="50" cy="50" r="40" /><text x="50" y="55" class="big">—</text></svg>
      <b>{label}</b>
      <small>{text || cfError(e)}</small>
    </div>
  );
}

// ---------------- 7 days ----------------
export function CloudDays({ nav }) {
  const st = useLoad(() => admin.cf('history'), []);
  return (
    <Page title="Last 7 days" sub="Each day as a share of its daily cap (UTC days)" nav={nav} right={<Refresh st={st} />}>
      <Loading st={st} rows={4}>
        {(h) => {
          if (!h.token) return <EmptyState icon="key" title="Needs the token" text="These numbers come from Cloudflare itself."><Button kind="soft" onClick={() => nav.push('cloudToken')}>Set up the token</Button></EmptyState>;
          const L = h.limits;
          const col = (k, lim, extra) => h.days.map((x) => ({ label: dayLong(x.day) + (x.today ? ' (today)' : ''), short: x.today ? 'Today' : dayShort(x.day),
            value: x[k] == null ? null : (100 * x[k]) / lim, extra: x[k] == null ? '' : extra(x) }));
          const full = h.days.filter((x) => !x.today && x.requests != null);
          const avg = full.length ? full.reduce((a, x) => a + x.requests, 0) / full.length : null;
          return (
            <>
              {h.workers_error ? <p class="note alert-t" style={{ marginBottom: '8px' }}>Requests: {cfError(h.workers_error)}</p> : null}
              {h.d1_error ? <p class="note alert-t" style={{ marginBottom: '8px' }}>D1: {cfError(h.d1_error)}</p> : null}
              <div class="card stack">
                <DayColumns label="Worker requests" days={col('requests', L.requests, (x) => `${short(x.requests)} · ${n(x.errors)} errors`)} />
                <DayColumns label="D1 rows written" days={col('rows_written', L.rowsWritten, (x) => short(x.rows_written))} />
                <DayColumns label="D1 rows read" days={col('rows_read', L.rowsRead, (x) => short(x.rows_read))} />
              </div>
              <p class="note" style={{ marginTop: '8px' }}>Dashed line = the daily cap. Blue under 60%, amber 60–85%, red above 85%. Tap a column for its day.</p>
              {avg != null ? <p class="note">Average requests on full days: {short(Math.round(avg))} ({pctText((100 * avg) / L.requests)} of the cap).</p> : null}
              <Section title="Day by day" />
              <List>{h.days.slice().reverse().map((x) => {
                const top = Math.max(x.requests ? (100 * x.requests) / L.requests : 0, x.rows_written ? (100 * x.rows_written) / L.rowsWritten : 0, x.rows_read ? (100 * x.rows_read) / L.rowsRead : 0);
                return <Row icon="clock" title={dayLong(x.day) + (x.today ? ' · today' : '')} wrap
                  sub={`${x.requests == null ? '—' : short(x.requests)} requests · ${x.errors == null ? '—' : n(x.errors)} errors · ${x.rows_read == null ? '—' : short(x.rows_read)} read · ${x.rows_written == null ? '—' : short(x.rows_written)} written · ${bytes(x.size)}`}
                  end={<Tag tone={quotaTone(top)}>{pctText(top)}</Tag>} />;
              })}</List>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// ---------------- errors ----------------
export function CloudErrors({ nav }) {
  const st = useLoad(() => admin.cf('errors'), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Errors" sub="Last 24 hours, and what the Worker logged" nav={nav} right={<Refresh st={st} />}>
      <Loading st={st} rows={5}>
        {(e) => (
          <>
            {e.token ? (
              <div class="card">
                <div class="cap" style={{ marginBottom: '10px' }}>How requests ended (Cloudflare)</div>
                {e.status_error ? <p class="note alert-t">{cfError(e.status_error)}</p>
                  : Object.keys(e.status).length ? <StackBar parts={statusParts(e.status)} /> : <p class="note">No requests in 24 hours.</p>}
                {e.status && (e.status.exceededCpu || 0) + (e.status.exceededResources || 0) ? <p class="note alert-t" style={{ marginTop: '10px' }}>Requests over the Free plan's 10 ms CPU give the user an error.</p> : null}
              </div>
            ) : null}
            <Section title="Logged by the Worker" link={owner && e.log.length ? 'Clear list' : null}
              onLink={() => act('cf.errors_clear', {}, { confirm: 'Clear the error list? New errors are logged again.', done: 'Error list cleared', after: st.reload })} />
            {e.log.length ? (
              <List>{e.log.map((r) => <Row icon="bug" title={r.message} wrap
                sub={`${plural(r.count, 'time')} · last ${ago(r.last_at, e.now)}${r.detail ? ' · ' + String(r.detail).slice(0, 160) : ''}`}
                end={e.now - r.first_at < 86400 ? <Tag tone="bad">New</Tag> : null} />)}</List>
            ) : <EmptyState icon="check" title="Nothing logged" text="The Worker has not logged an error." />}
            <p class="note" style={{ marginTop: '10px' }}>Addresses, emails, IPs and keys are removed before saving. Rows older than 14 days go by themselves.</p>
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- costly queries ----------------
export function CloudQueries({ nav }) {
  const st = useLoad(() => admin.cf('queries'), []);
  return (
    <Page title="Costliest queries" sub="Yesterday and today (UTC), all databases" nav={nav} right={<Refresh st={st} />}>
      <Loading st={st} rows={5}>
        {(d) => {
          if (!d.token) return <EmptyState icon="key" title="Needs the token" text="These numbers come from Cloudflare itself."><Button kind="soft" onClick={() => nav.push('cloudToken')}>Set up the token</Button></EmptyState>;
          if (d.error) return <EmptyState icon="warn" title="Could not read" text={cfError(d.error)}><Button kind="soft" onClick={st.reload}>Try again</Button></EmptyState>;
          if (!d.any) return <EmptyState icon="check" title="No queries recorded" />;
          return (
            <>
              <Section title="Most rows read" />
              <div class="list">{d.read.map((x) => <ShareRow share={x.share} tone="blue" title={x.query} sub={`${short(x.rows)} rows · ≈${short(x.runs)} runs`} />)}</div>
              <Section title="Most rows written" />
              <div class="list">{d.written.length ? d.written.map((x) => <ShareRow share={x.share} tone="warn" title={x.query} sub={`${short(x.rows)} rows · ≈${short(x.runs)} runs`} />) : <p class="note" style={{ padding: '12px 16px' }}>Nothing written.</p>}</div>
              <p class="note" style={{ marginTop: '10px' }}>When one query takes most of the share, that is the best place to optimise (an index or a cache).</p>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// ---------------- deploys ----------------
export function CloudDeploys({ nav }) {
  const st = useLoad(() => admin.cf('deploys'), []);
  return (
    <Page title="Deploys and builds" nav={nav} right={<Refresh st={st} />}>
      <Loading st={st} rows={5}>
        {(d) => (
          <>
            {d.behind ? (
              d.behind.commits ? <Banner tone="warn" icon="warn" title={`${plural(d.behind.commits, 'commit')} on main not deployed`}>{d.behind.prs.length ? `PR ${d.behind.prs.map((x) => '#' + x).join(', ')} merged, waiting for Deploy.` : 'Merged, waiting for Deploy.'}</Banner>
                : <Banner tone="ok" icon="check" title="Live is up to date">The last good deploy is the current main.</Banner>
            ) : null}
            {d.live ? (
              <div style={{ marginTop: '10px' }}>
                {d.live.at ? <Banner icon="cloud" title={`Running on Cloudflare since ${ago(d.live.at, d.now)}`}>Deployed {clock(d.live.at)} your time.</Banner>
                  : d.live.error === 'perm' ? <p class="note">Give the token Workers Scripts: Read too, to see the version that is live.</p> : null}
              </div>
            ) : null}
            <Section title="Server deploys" />
            {d.deploys_error ? <p class="note alert-t">GitHub: {d.deploys_error.code === 'no_answer' ? 'no answer' : d.deploys_error.code}</p>
              : d.deploys.length ? <List>{d.deploys.map((r) => <Row avatar={<span class={'statdot ' + (RUN_TONE[r.state] || '')} />} title={`#${r.number} · ${RUN_STATE[r.state]}`} sub={`${ago(r.at, d.now)} · ${r.sha}`} />)}</List>
                : <p class="note">Not run yet.</p>}
            <Section title="Pleat app builds" />
            {d.builds_error ? <p class="note alert-t">GitHub: {d.builds_error.code === 'no_answer' ? 'no answer' : d.builds_error.code}</p>
              : d.builds.length ? <List>{d.builds.map((r) => <Row avatar={<span class={'statdot ' + (RUN_TONE[r.state] || '')} />} title={`#${r.number} · ${RUN_STATE[r.state]}`} sub={ago(r.at, d.now)} />)}</List>
                : <p class="note">Not run yet.</p>}
            <div style={{ marginTop: '16px' }}><Button kind="soft" onClick={() => openLink(d.actions_url)}>Open GitHub Actions</Button></div>
            <p class="note" style={{ marginTop: '10px' }}>Deploys and builds are run by hand from GitHub; this page only shows their state.</p>
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- token ----------------
export function CloudToken({ nav }) {
  const st = useLoad(() => admin.cf('token'), []);
  return (
    <Page title="Cloudflare token" nav={nav} right={<Refresh st={st} />}>
      <Loading st={st} rows={3}>
        {(t) => (
          <>
            {!t.have ? <Banner icon="key" title="No token yet">Without it you still see the database size, the Worker's own errors and the cron.</Banner>
              : t.works ? <Banner tone="ok" icon="check" title="The token works">Cloudflare's numbers are being read.</Banner>
                : <Banner tone="bad" icon="warn" title="The token is there but does not work">{cfError(t.error)}</Banner>}
            <Section title="Make the token (once)" />
            <div class="card">
              <ol class="steps">
                <li><span>dash.cloudflare.com › My Profile › API Tokens › Create Token › <b>Create Custom Token</b>.</span></li>
                <li><span>Permissions: <b>Account › Account Analytics › Read</b>. Optional: Account › Workers Scripts › Read, to see the live version.</span></li>
                <li><span>Account Resources: only this account. Leave the rest and create the token.</span></li>
                <li><span>Workers &amp; Pages › cloudgold › Settings › Variables and Secrets › Add: type <b>Secret</b>, name <span class="mono">CF_ANALYTICS_TOKEN</span>, value = the token.</span></li>
              </ol>
            </div>
            <p class="note" style={{ marginTop: '10px' }}>The token only reads: it cannot change anything and has no access to panels or money. It is never shown here or in the bot.</p>
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- system health: sync now / retry stuck ----------------
export async function syncNow(after) {
  try {
    const r = await admin.syncNow();
    if (r.ok) toast(`Sync ran: ${plural(r.pushed, 'change')} pushed, ${plural(r.created, 'account')} made, ${plural(r.expired, 'plan')} closed`);
    else toast('The sync did not finish; the error is in Cloudflare › Errors.', { bad: true });
  } catch (e) { toast(e.message, { bad: true }); }
  after && after();
}
export const SyncActs = ({ q, owner, after }) => (owner ? (
  <div class="btns" style={{ marginTop: '12px' }}>
    <Button kind="soft" onClick={() => syncNow(after)}>Sync now</Button>
    {q.stuck ? <Button kind="ghost" onClick={() => act('sync.retry', {}, { done: 'Stuck accounts are back at the front of the queue', after })}>Retry {n(q.stuck)} stuck</Button> : null}
  </div>
) : null);
