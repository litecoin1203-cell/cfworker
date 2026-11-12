// Network side: panels (add, login, test, roll out, groups, rename, remove), each panel's servers (hide, rename),
// the Pleat app's settings (announcement, support, emergency domains and bridges, trial, updates) and the
// carriers ranking with Google's view of each server.
import { useState } from 'preact/hooks';
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Chips, Tag, Act, Button, EmptyState, KV, openForm, toast, Toggle, confirmDialog } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, ago, day, plural, PANEL_STATE, PANEL_TONE, NET_KIND, GOOGLE, GOOGLE_TONE } from './fmt.js';
import { haptic } from '../tg.js';

const KINDS = [{ value: 'auto', label: 'Find out by itself' }, { value: 'pasarguard', label: 'PasarGuard' }, { value: 'marzban', label: 'Marzban' }, { value: 'rebecca', label: 'Rebecca' }];

function testText(t) {
  if (!t) return 'Not tested yet';
  if (t.healthy) return `Healthy · ${plural(t.configs, 'config')}${t.version ? ' · v' + t.version : ''}${t.unusable ? ` · ${t.unusable} the app cannot use` : ''}`;
  return `Failed: ${t.error || 'the subscription link had no configs'}${t.needs_service ? ' · Rebecca needs a service id (Groups)' : ''}`;
}

async function credForm(id, after) {
  await openForm({
    title: 'Panel login', lead: 'The admin login of the panel. Stored encrypted and never shown again. The panel is tested right after.', submit: 'Save and test',
    fields: [{ key: 'url', label: 'Panel address', type: 'url', required: true, placeholder: 'https://panel.example.com:8000/dashboard/' },
      { key: 'username', label: 'Admin username', required: true }, { key: 'password', label: 'Password', type: 'password', required: true }],
    onSubmit: async (v) => {
      const r = await admin.panelCred(id, { url: v.url.trim(), username: v.username.trim(), password: v.password });
      haptic(r.test.healthy ? 'success' : 'error');
      toast(r.test.healthy ? `Saved. ${testText(r.test)}` : `Saved, but the test failed: ${r.test.error || 'no configs'}`, { bad: !r.test.healthy });
      after();
    },
  });
}

async function addPanelForm(nav, after) {
  await openForm({
    title: 'Add a panel', lead: 'It takes nobody until you test it and give it a share of users.', submit: 'Add',
    fields: [{ key: 'label', label: 'Name', required: true, placeholder: 'Germany 2', max: 40 }, { key: 'kind', label: 'Type', type: 'select', value: 'auto', options: KINDS }],
    onSubmit: async (v) => {
      const r = await admin.addPanel(v.label.trim(), v.kind);
      after();
      nav.push('panel', { id: r.id });
      setTimeout(() => credForm(r.id, after), 350);
    },
  });
}

export function Panels({ nav }) {
  const st = useLoad(() => admin.panels(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Panels" nav={nav} right={owner ? <button type="button" class="iconbtn" aria-label="Add panel" onClick={() => addPanelForm(nav, st.reload)}><Icon name="plus" /></button> : null}>
      <Loading st={st} rows={3}>
        {(d) => (d.panels.length ? (
          <>
            <List>{d.panels.map((p) => <Row icon="layers" title={p.label} sub={`${p.kind} · ${plural(p.accounts, 'account')}${p.version ? ' · v' + p.version : ''} · health ${p.health}`}
              end={<Tag tone={p.create_error ? 'bad' : PANEL_TONE[p.state]}>{p.create_error ? 'Error' : `${PANEL_STATE[p.state] || p.state}${p.state === 'rollout' ? ' ' + p.pct + '%' : ''}`}</Tag>}
              onClick={() => nav.push('panel', { id: p.id })} />)}</List>
            <p class="note" style={{ marginTop: '10px' }}>Rolling out = that share of users also gets an account on this panel. Active = everyone.</p>
          </>
        ) : <EmptyState icon="layers" title="No panels" text="Add your first panel with the + button." />)}
      </Loading>
    </Page>
  );
}

export function PanelDetail({ p, nav }) {
  const st = useLoad(() => admin.panel(p.id), [p.id]);
  const [testing, setTesting] = useState(false);
  const owner = nav.role === 'owner';
  const test = async () => {
    setTesting(true);
    try { const r = await admin.panelTest(p.id); haptic(r.test.healthy ? 'success' : 'error'); toast(testText(r.test), { bad: !r.test.healthy }); st.reload(); } catch (e) { toast(e.message, { bad: true }); }
    setTesting(false);
  };
  const drain = async (pn) => {
    const all = (await admin.panels()).panels;
    if (!all.some((x) => x.id !== pn.id && ['active', 'rollout'].includes(x.state))) { toast('This is the only active panel. Add and roll out another one first.', { bad: true }); return; }
    act('panel.drain', { panelId: pn.id }, { confirm: `Remove ${pn.label}? Its ${pn.accounts} active accounts switch off after one last usage read; users stay on your other panels with their usage. This cannot be undone.`, done: 'Leaving: it is out of the server list now', after: st.reload });
  };
  return (
    <Loading st={st} rows={5}>
      {(pn) => {
        const canShare = ['testing', 'rollout', 'active'].includes(pn.state);
        return (
          <Page title={pn.label} sub={`${pn.kind} · panel #${pn.id}`} nav={nav}>
            <div class="card">
              <div class="cap">Share of users</div>
              <div class="disp"><b>{pn.state === 'active' ? 100 : pn.state === 'rollout' ? pn.pct : 0}</b><span>%</span><span class="of"><Tag tone={PANEL_TONE[pn.state]}>{PANEL_STATE[pn.state] || pn.state}</Tag></span></div>
              <div class="meter"><i style={{ width: `${pn.state === 'active' ? 100 : pn.state === 'rollout' ? pn.pct : 0}%` }} /></div>
              <div style={{ marginTop: '12px' }}>
                <KV k="Active accounts">{n(pn.accounts)}</KV>
                {pn.progress && pn.progress.want ? <KV k="Accounts made">{n(pn.progress.have)} of {n(pn.progress.want)}</KV> : null}
                <KV k="Health">{pn.health} / 100</KV>
                {pn.version ? <KV k="Version">{pn.version}</KV> : null}
                <KV k="Login">{pn.cred_fixed ? 'From the server secrets' : pn.cred ? 'Saved (encrypted)' : 'Not set'}</KV>
                {pn.groups && pn.groups.length ? <KV k="Groups / service">{pn.groups.join(', ')}</KV> : null}
              </div>
            </div>
            {pn.create_error ? <div class="card tight" style={{ marginTop: '12px' }}><div class="cap alert-t">Refusing new accounts</div><p style={{ marginTop: '6px', fontSize: '14px' }}>{pn.create_error}</p></div> : null}
            <Section title="Last test" />
            <List>
              <Row icon={pn.test && pn.test.healthy ? 'check' : 'warn'} title={pn.test ? (pn.test.healthy ? 'Healthy' : 'Failed') : 'Not tested yet'}
                sub={pn.test ? `${ago(pn.test.at)}${pn.test.configs ? ' · ' + plural(pn.test.configs, 'config') : ''}${pn.test.kinds ? ' · ' + Object.entries(pn.test.kinds).map(([k, c]) => `${k} ×${c}`).join(', ') : ''}${pn.test.error ? ' · ' + pn.test.error : ''}` : 'Log in, make a test user, read its configs, delete it'}
                wrap end={owner ? <Act kind="solid" onClick={test} disabled={testing}>{testing ? 'Testing' : 'Test'}</Act> : null} />
            </List>
            {owner ? (
              <>
                {canShare ? (
                  <>
                    <Section title="Give it users" />
                    <Chips items={[0, 10, 25, 50, 100].map((x) => ({ k: x, label: x === 100 ? 'Everyone' : x + '%' }))} value={pn.state === 'active' ? 100 : pn.state === 'rollout' ? pn.pct : 0}
                      onChange={(pct) => act('panel.rollout', { panelId: pn.id, pct }, { done: pct ? `${pct === 100 ? 'Everyone' : pct + '% of users'} now get an account here` : 'Share set to 0', after: st.reload })} />
                  </>
                ) : null}
                <Section title="Manage" />
                <List>
                  <Row icon="server" title="Servers" sub="Hide one from the app, or give it a name" onClick={() => nav.push('servers', { id: pn.id, label: pn.label })} chevron />
                  {!pn.cred_fixed ? <Row icon="key" title="Login" sub="Address, admin username, password" onClick={() => credForm(pn.id, st.reload)} chevron /> : null}
                  <Row icon="users" title="Groups / service" sub={pn.groups && pn.groups.length ? pn.groups.join(', ') : 'Every group the admin may use'} onClick={async () => {
                    const v = await openForm({ title: 'Groups / service', lead: 'Group ids (PasarGuard, Marzban) or the service id (Rebecca), comma separated. Empty = all allowed.', submit: 'Save', fields: [{ key: 'ids', label: 'Ids', value: (pn.groups || []).join(','), placeholder: '1,2' }] });
                    if (v) act('panel.groups', { panelId: pn.id, ids: v.ids.split(',').map((x) => x.trim()).filter(Boolean) }, { done: 'Groups saved', after: st.reload });
                  }} chevron />
                  <Row icon="edit" title="Rename" onClick={async () => {
                    const v = await openForm({ title: 'Panel name', submit: 'Save', fields: [{ key: 'label', label: 'Name', value: pn.label, max: 40, required: true }] });
                    if (v) act('panel.rename', { panelId: pn.id, label: v.label.trim() }, { done: 'Renamed', after: st.reload });
                  }} chevron />
                  {pn.state === 'disabled' ? <Row icon="refresh" title="Enable again" sub="Back to tested; takes nobody until you give it a share" onClick={() => act('panel.enable', { panelId: pn.id }, { done: 'Back to tested', after: st.reload })} chevron /> : null}
                  <Row icon="history" title="History" onClick={() => nav.push('audit', { type: 'panel', id: String(pn.id) })} chevron />
                  {!['draining', 'disabled'].includes(pn.state) ? <Row icon="trash" title="Remove panel" sub="Out of the list now, accounts off after one last read" danger onClick={() => drain(pn)} chevron /> : null}
                </List>
              </>
            ) : null}
          </Page>
        );
      }}
    </Loading>
  );
}

const srvSub = (s) => [s.label ? `auto: ${s.name}` : null, s.type, s.tunnel ? 'Iran tunnel' : null,
  s.cc ? (s.named ? `${s.cc} (panel name says ${s.named})` : s.cc) : s.gone ? null : 'country unknown', s.gone ? 'not on the panel now' : null].filter(Boolean).join(' · ');

export function PanelServers({ p, nav }) {
  const st = useLoad(() => admin.panelServers(p.id), [p.id]);
  const owner = nav.role === 'owner';
  return (
    <Page title="Servers" sub={p.label} nav={nav} right={<button type="button" class="iconbtn" aria-label="Refresh" onClick={st.reload}><Icon name="refresh" /></button>}>
      <Loading st={st} rows={6}>
        {(d) => (
          <>
            {d.source === 'none' ? <p class="note" style={{ marginBottom: '10px' }}>No active user on this panel yet, so its server list cannot be read.</p> : null}
            {d.source === 'error' ? <p class="note alert-t" style={{ marginBottom: '10px' }}>The panel did not answer; the list could not be read.</p> : null}
            {d.servers.length ? (
              <List>{d.servers.map((s) => <Row icon={s.tunnel ? 'tunnel' : 'server'} title={s.label || s.name} sub={srvSub(s)} wrap
                onClick={() => nav.push('server', { id: p.id, panel: p.label, s })}
                end={owner ? <Toggle on={!s.hidden} label="Shown in the app" onChange={(show) => act('server.hide', { panelId: p.id, key: s.key, on: !show }, { done: show ? 'Shown in the app' : 'Hidden from the app', after: st.reload })} /> : <Tag tone={s.hidden ? '' : 'ok'}>{s.hidden ? 'Hidden' : 'Shown'}</Tag>} />)}</List>
            ) : d.source === 'ok' || d.source === 'cache' ? <EmptyState icon="server" title="No servers" /> : null}
            {d.servers.some((s) => !s.cc && !s.gone) ? <p class="note" style={{ marginTop: '10px' }}>Country unknown = the config's name on the panel has no country. Put a flag or a country name in it on the panel (🇩🇪, Germany), or give it a name here with a flag. Pleat also learns the real country once someone connects to it.</p> : null}
            <List>
              <Row icon="tunnel" title="Iran tunnel diagnostic" sub="Why configs are (not) marked as tunnel" onClick={() => nav.push('tunnel', { id: p.id, label: p.label })} chevron />
            </List>
            <p class="note" style={{ marginTop: '10px' }}>The switch shows or hides a server in the app. Tap a server for its name, country and network stats. Addresses and links are never shown here.</p>
          </>
        )}
      </Loading>
    </Page>
  );
}

// one server of a panel: shown or hidden in the app, its name in the app, its real country, network stats, history
export function ServerDetail({ p, nav }) {
  const st = useLoad(() => admin.panelServers(p.id), [p.id]);
  const owner = nav.role === 'owner';
  return (
    <Loading st={st} rows={4}>
      {(d) => {
        const s = d.servers.find((x) => x.key === p.s.key) || p.s;
        const rename = async () => {
          const v = await openForm({ title: 'Name in the app', lead: 'English letters, digits or emoji, up to 40. A flag sets the country. Empty = the automatic name. Rankings keep working after a rename.', submit: 'Save',
            fields: [{ key: 'label', label: 'Name', value: s.label || '', placeholder: s.name, max: 40 }] });
          if (v) act('server.rename', { panelId: p.id, key: s.key, label: v.label.trim() }, { done: v.label.trim() ? 'Renamed' : 'Back to the automatic name', after: st.reload });
        };
        return (
          <Page title={s.label || s.name} sub={`${p.panel || 'Panel #' + p.id}${s.type ? ' · ' + s.type : ''}`} nav={nav}>
            <div class="card">
              <KV k="Shown in the app">{owner ? <Toggle on={!s.hidden} label="Shown in the app" onChange={(show) => act('server.hide', { panelId: p.id, key: s.key, on: !show }, { done: show ? 'Shown in the app' : 'Hidden from the app', after: st.reload })} /> : s.hidden ? 'Hidden' : 'Shown'}</KV>
              <KV k="Name in the app">{s.label || `Automatic (${s.name})`}</KV>
              <KV k="Country">{s.cc || 'Unknown'}</KV>
              {s.tunnel ? <KV k="Route">Iran tunnel</KV> : null}
              {s.gone ? <KV k="On the panel">Not any more</KV> : null}
            </div>
            {s.named ? <p class="note" style={{ marginTop: '10px' }}>Its panel name says {s.named}, but its real exit (seen from its IP) is in {s.cc}; the app shows {s.cc}.</p> : null}
            {!s.cc && s.remark ? <p class="note" style={{ marginTop: '10px' }}>Name on the panel: “<bdi>{s.remark}</bdi>”. The country is read from a flag, a country or city name, or a two-letter code in it. To fix it here, give it a name with a flag (for example 🇩🇪 Germany Tunnel).</p> : null}
            <Section title="Manage" />
            <List>
              {owner ? <Row icon="edit" title="Name in the app" sub={s.label ? s.label : 'Automatic'} onClick={rename} chevron /> : null}
              {owner && s.label ? <Row icon="undo" title="Back to the automatic name" onClick={() => act('server.rename', { panelId: p.id, key: s.key, label: '' }, { done: 'Back to the automatic name', after: st.reload })} chevron /> : null}
              <Row icon="wifi" title="Network stats" sub="This server on every carrier, and Google's view" onClick={() => nav.push('netServer', { key: s.key, name: s.label || s.name })} chevron />
              <Row icon="pulse" title="App health reports" sub="Open problems on this exit" onClick={() => nav.push('reportList', { server: s.key, title: s.label || s.name })} chevron />
              <Row icon="history" title="History" onClick={() => nav.push('audit', { type: 'server', id: `${p.id}.${s.key}` })} chevron />
            </List>
            <p class="note" style={{ marginTop: '10px' }}>Rankings and stats follow the server's fixed key, so a new name keeps them.</p>
          </Page>
        );
      }}
    </Loading>
  );
}

const HTTP = (n) => (n === 200 ? <Tag tone="ok">200 OK</Tag> : <Tag tone="bad">{n ? 'HTTP ' + n : 'No answer'}</Tag>);
const PROBE = { no_group: 'no group named Tunnel in the simple list' };

// Why configs are (not) marked as Iran tunnel: what the Worker can read on the panel, step by step
export function TunnelDiag({ p, nav }) {
  const st = useLoad(() => admin.tunnel(p.id, false), [p.id]);
  const owner = nav.role === 'owner';
  const reread = async () => {
    try { await admin.tunnel(p.id, true); toast('Read again and stored'); } catch (e) { toast(e.message, { bad: true }); }
    st.reload();
  };
  return (
    <Page title="Iran tunnel" sub={p.label} nav={nav} right={<button type="button" class="iconbtn" aria-label="Refresh" onClick={st.reload}><Icon name="refresh" /></button>}>
      <Loading st={st} rows={5}>
        {(t) => {
          const d = t.diag;
          const blocked = d && d.kind === 'pasarguard' && (d.groups_status !== 200 || d.hosts_status !== 200);
          return (
            <>
              {!d ? <EmptyState icon="warn" title="The panel could not be read" text={t.error || ''} />
                : d.kind !== 'pasarguard' ? <p class="note">This panel is {d.kind}; it has no groups. The tunnel mark works on PasarGuard only.</p> : (
                  <List>
                    <Row icon="layers" title="1. Read groups" sub={d.groups_status !== 200 ? (d.simple_status === 200 ? 'The simple list was read but without inbound tags; not enough. The panel admin probably needs sudo.' : 'The simple list could not be read either. The panel admin probably needs sudo.')
                      : d.groups ? d.groups.map((g) => `${g.name}${g.off ? ' (off)' : ''}${g.tags == null ? '' : ` [${g.tags}]`}`).join(', ') || '—' : ''} wrap end={HTTP(d.groups_status)} />
                    <Row icon="tunnel" title="2. Tunnel group" sub={d.tunnel_groups.length ? `${d.tunnel_groups.join(', ')} · ${plural(d.tags, 'inbound')}` : 'No group named Tunnel'} wrap end={<Tag tone={d.tunnel_groups.length ? 'ok' : 'bad'}>{d.tunnel_groups.length ? 'Found' : 'Missing'}</Tag>} />
                    <Row icon="server" title="3. Read hosts" sub={d.hosts_status === 200 ? plural(d.hosts || 0, 'host') : 'Without hosts a config cannot be tied to a group.'} wrap end={HTTP(d.hosts_status)} />
                    <Row icon="route" title="4. Tunnel hosts" end={<b class="num">{n(d.tunnel_hosts)}</b>} />
                  </List>
                )}
              {blocked ? (
                <div class={'banner ' + (t.probe && t.probe.ok ? 'ok' : 'warn')} style={{ marginTop: '12px' }}>
                  <Icon name={t.probe && t.probe.ok ? 'check' : 'info'} />
                  <span><b>The other way: a probe user</b>{t.probe && t.probe.ok ? 'A test user (cgtunnel_…) lives only in the Tunnel group; its configs count as tunnel. Do not delete it.'
                    : t.probe && t.probe.error ? `It failed (${PROBE[t.probe.error] || t.probe.error}): the panel admin may not create users in the Tunnel group.` : 'Reading again makes a test user that lives only in the Tunnel group.'}</span>
                </div>
              ) : null}
              <p class="note" style={{ marginTop: '12px' }}>{t.stored ? `Stored in the Worker: ${plural(t.stored.rules, 'rule')} (${n(t.stored.tunnel_rules)} tunnel), ${ago(t.stored.at)}.` : 'Nothing stored yet (the Worker reads every 15 minutes).'} Tunnel servers carry the tunnel icon in the server list.</p>
              {owner ? <div style={{ marginTop: '14px' }}><Button kind="soft" onClick={reread}>Read again and store</Button></div> : null}
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// one server on every carrier (rank, connect rate, ping, speed) and how Google sees it
export function NetServer({ p, nav }) {
  const st = useLoad(() => admin.netServer(p.key), [p.key]);
  const owner = nav.role === 'owner';
  return (
    <Loading st={st} rows={4}>
      {(d) => (
        <Page title={d.name || p.name || 'Server'} sub="Last 3 days of tests from users' phones" nav={nav}>
          <div class="card tight">
            <KV k="Google">{d.google ? <><Tag tone={GOOGLE_TONE[d.google.status]}>{d.google.status === 'google' ? 'OK' : d.google.status === 'no_gemini' ? 'Partly' : 'Bad'}</Tag> {GOOGLE[d.google.status]} · {plural(d.google.tests, 'test')}</> : 'No Google test yet'}</KV>
          </div>
          <Section title="On each carrier" />
          {d.carriers.length ? (
            <List>{d.carriers.map((c) => <Row icon="wifi" title={c.isp} sub={[`connects ${c.ok_pct}%`, c.ms ? `${c.ms} ms` : null, c.mbps ? `${c.mbps} Mbps` : null, plural(c.users, 'user')].filter(Boolean).join(' · ')}
              end={<Tag tone={c.rank === 1 ? 'ok' : c.rank > c.of - 2 && c.of > 3 ? 'bad' : ''}>#{c.rank} of {c.of}</Tag>} />)}</List>
          ) : <EmptyState icon="wifi" title="Not tested" text="No carrier tested this server in 3 days." />}
          {owner ? <div style={{ marginTop: '16px' }}><Button kind="ghost" onClick={() => act('net.reset', { kind: 's', id: d.key }, { confirm: `Clear every network stat of ${d.name || 'this server'}? The ranking rebuilds from new reports.`, done: 'Server stats cleared', after: st.reload })}>Clear this server's stats</Button></div> : null}
        </Page>
      )}
    </Loading>
  );
}

// ---------------- Pleat app ----------------
function ListEditor({ title, items, k, after, owner, add, hint, test }) {
  return (
    <>
      <Section title={`${title} · ${items.length} of 8`} link={owner ? 'Add' : null} onLink={add} />
      {items.length ? (
        <List>{items.map((it, i) => <Row icon={k === 'd' ? 'globe' : 'route'} title={<span class="mono">{it.value}</span>} sub={`Tried ${i === 0 ? 'first' : `#${i + 1}`}`}
          end={owner ? <>
            {i ? <Act kind="ghost" onClick={() => act('app.list', { k, op: 'move', index: i, dir: 'u', tag: it.tag }, { done: 'Moved up', after })}>Up</Act> : null}
            <Act kind="danger" onClick={() => act('app.list', { k, op: 'remove', index: i, tag: it.tag }, { done: 'Removed', after })}>Remove</Act>
          </> : null} />)}</List>
      ) : <p class="note">Empty.</p>}
      <p class="note" style={{ marginTop: '8px' }}>{hint}</p>
      {test && items.length ? <div style={{ marginTop: '10px' }}><Button kind="soft" onClick={test}>Test the domains</Button></div> : null}
    </>
  );
}

export function AppSettings({ nav }) {
  const st = useLoad(() => admin.app(), []);
  const owner = nav.role === 'owner';
  const after = st.reload;
  const setting = (key, val, done) => act('setting.set', { key, val: String(val) }, { done, after });
  const addItem = async (k) => {
    const v = await openForm({ title: k === 'd' ? 'Add a domain' : 'Add a bridge', submit: 'Add',
      fields: [{ key: 'v', label: k === 'd' ? 'Address' : 'Config link', required: true, type: k === 'd' ? 'url' : 'text', max: 2000,
        placeholder: k === 'd' ? 'https://api.example.com' : 'vless://…', hint: k === 'd' ? 'https and a domain only, no path.' : 'vless, vmess, trojan, ss, hysteria2 or wireguard. Never shown in full again.' }] });
    if (v) act('app.list', { k, op: 'add', value: v.v.trim() }, { done: 'Added', after });
  };
  const testDomains = async () => {
    try {
      const r = await admin.domainTest();
      await openForm({ title: 'Domain test', lead: 'From Cloudflare, not from Iran: OK means the domain reaches this Worker, not that it is open in Iran.', submit: 'Close',
        fields: r.results.map((x, i) => ({ key: 'd' + i, label: x.domain.replace(/^https:\/\//, ''), value: x.ok ? `OK · ${x.ms} ms` : `Failed · ${x.why}` })) });
    } catch (e) { toast(e.message, { bad: true }); }
  };
  return (
    <Page title="Pleat app" nav={nav}>
      <Loading st={st} rows={6}>
        {(d) => {
          const rel = d.release;
          return (
            <>
              <Section title="What users see" />
              <List>
                <Row icon="megaphone" title="Announcement" sub={d.announcement || 'Nothing shown in the app'} wrap onClick={owner ? async () => {
                  const v = await openForm({ title: 'Announcement', lead: 'A line at the top of the app. Empty = nothing shown.', submit: 'Save', fields: [{ key: 'v', label: 'Text', type: 'textarea', value: d.announcement, max: 1000 }] });
                  if (v) setting('announcement', v.v.trim(), v.v.trim() ? 'Announcement saved' : 'Announcement cleared');
                } : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
                <Row icon="message" title="Support link" sub={d.support_url || 'Not set'} onClick={owner ? async () => {
                  const v = await openForm({ title: 'Support link', submit: 'Save', fields: [{ key: 'v', label: 'Link', value: d.support_url, placeholder: 'https://t.me/your_support', hint: 'https:// or tg://. Empty = no support button.' }] });
                  if (v) setting('support_url', v.v.trim(), 'Support link saved');
                } : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
              </List>
              <Section title="Free trial" />
              <List>
                <Row icon="gift" title="Trial plans" sub={d.trial.plans.length ? d.trial.plans.map((x) => `${x.name} · ${x.trial_days} days`).join(', ') : 'No plan has a trial'} onClick={() => nav.push('plans')} chevron />
                <Row icon="lock" title="Only with a verified Telegram" sub="One trial per Telegram account" end={owner ? <Toggle on={d.trial.telegram_only} label="Verified Telegram only" onChange={(v) => setting('trial_needs_telegram', v ? '1' : '0', v ? 'Trial: verified Telegram only' : 'Trial: everyone')} /> : <Tag>{d.trial.telegram_only ? 'On' : 'Off'}</Tag>} />
              </List>
              <p class="note" style={{ margin: '10px 0 4px' }}>Trial data</p>
              {owner ? <Chips items={[0, 1, 2, 5].map((x) => ({ k: x, label: x ? x + ' GB' : 'Same as plan' }))} value={d.trial.gb} onChange={(v) => setting('trial_data_gb', v, 'Trial data saved')} /> : <p class="note">{d.trial.gb ? d.trial.gb + ' GB' : 'Same as plan'}</p>}
              <ListEditor title="Extra domains" k="d" items={d.domains} owner={owner} after={after} add={() => addItem('d')} test={testDomains}
                hint="If the main domain is filtered, the app tries these in order. Reaches every installed app on its next start, no new APK." />
              <ListEditor title="Bridges" k="b" items={d.bridges} owner={owner} after={after} add={() => addItem('b')}
                hint="When no domain opens, the app uses these configs to reach the server. Only the start and end of each link is shown." />
              <Section title="App updates" />
              <div class="card">
                {!rel.token ? <p class="alert-t" style={{ fontSize: '14px', marginBottom: '10px' }}>The download token (PLEAT_DL_TOKEN) is not on the server yet. Add it in GitHub › Settings › Secrets, then run Deploy.</p> : null}
                <KV k="Newest build">{rel.latest ? `${rel.latest.version} (build ${rel.latest.build}) · ${day(rel.latest.at)}` : 'Not found'}</KV>
                <KV k="Told to users">{rel.announced ? `${rel.announced.version} (build ${rel.announced.build})${rel.announced.force ? ' · required' : ''}` : 'Nothing'}</KV>
                {owner ? (
                  <div class="stack" style={{ marginTop: '12px' }}>
                    {rel.fresh ? <Button onClick={() => act('app.release', { op: 'announce' }, { confirm: `Tell every user about ${rel.latest.version}?`, done: `${rel.latest.version} announced`, after })}>Announce {rel.latest.version}</Button> : null}
                    {rel.announced ? (
                      <div class="btns">
                        <Button kind="soft" onClick={() => act('app.release', { op: 'force' }, { done: rel.announced.force ? 'No longer required' : 'Update is now required', after })}>{rel.announced.force ? 'Not required' : 'Make required'}</Button>
                        <Button kind="ghost" onClick={async () => { if (await confirmDialog('Stop offering this update?')) act('app.release', { op: 'withdraw' }, { done: 'Update withdrawn', after }); }}>Withdraw</Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Section title="Related" />
              <List>
                <Row icon="wallet" title="Minimum top-up" sub={`${n(d.min_topup_toman)} toman`} onClick={() => nav.push('payments')} chevron />
                <Row icon="gift" title="Referral reward" sub={`${d.referral_percent}%`} onClick={() => nav.push('referral')} chevron />
              </List>
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

// ---------------- network ----------------
export function Network({ nav }) {
  const [tab, setTab] = useState('carriers');
  const st = useLoad(() => admin.net(), []);
  const users = useLoad(() => (tab === 'users' ? admin.netUsers() : Promise.resolve(null)), [tab]);
  return (
    <Page title="Carriers" sub="Last 3 days of tests from users' phones" nav={nav}>
      <Chips items={[{ k: 'carriers', label: 'Best per carrier' }, { k: 'google', label: 'Google check' }, { k: 'users', label: 'Users' }]} value={tab} onChange={setTab} />
      {tab === 'users' ? (
        <Loading st={users} rows={5}>
          {(d) => (d ? (
            <>
              <Section title="Users per network (7 days)" />
              {d.groups.length ? <List>{d.groups.map((g) => <Row icon="wifi" title={g.isp} sub={NET_KIND[g.kind] || g.kind} end={<span class="num">{plural(g.users, 'user')}</span>} />)}</List> : <p class="note">No reports yet.</p>}
              <Section title="Reported last" />
              <List>{d.recent.map((r) => <Row icon="user" title={<bdi>{r.user}</bdi>} sub={ago(r.at)} onClick={() => nav.push('userNets', { id: r.id, label: r.user })} chevron />)}</List>
            </>
          ) : null)}
        </Loading>
      ) : (
        <Loading st={st} rows={5}>
          {(d) => (tab === 'carriers' ? (d.carriers.length ? (
            <List>{d.carriers.map((c) => <Row icon="wifi" title={c.isp} sub={`${plural(c.tests, 'test')} · best: ${c.servers[0] ? `${c.servers[0].name} (${c.servers[0].ok_pct}%${c.servers[0].ms ? ', ' + c.servers[0].ms + ' ms' : ''})` : '—'}`} onClick={() => nav.push('carrier', { asn: c.asn, c })} chevron />)}</List>
          ) : <EmptyState icon="wifi" title="No results yet" text="After a few tests in the app, the ranking shows here." />) : (d.google.length ? (
            <>
              <List>{d.google.map((g) => <Row icon="globe" title={g.name} sub={`${GOOGLE[g.status]} · seen as ${g.cc || '?'} · ${plural(g.tests, 'test')}`} onClick={() => nav.push('netServer', { key: g.key, name: g.name })} end={<Tag tone={GOOGLE_TONE[g.status]}>{g.status === 'google' ? 'OK' : g.status === 'no_gemini' ? 'Partly' : 'Bad'}</Tag>} />)}</List>
              <p class="note" style={{ marginTop: '10px' }}>For a red one: give that node another exit IP (for example WARP) so Google sees another country.</p>
            </>
          ) : <EmptyState icon="globe" title="No Google tests yet" text="Each user tests their server after connecting." />))}
        </Loading>
      )}
    </Page>
  );
}

export function Carrier({ p, nav }) {
  const c = p.c;
  const owner = nav.role === 'owner';
  const srv = (s, good) => <Row icon={good ? 'bolt' : 'server'} title={s.name} sub={[`connects ${s.ok_pct}%`, s.ms ? `${s.ms} ms` : null, s.mbps ? `${s.mbps} Mbps` : null, plural(s.users, 'user')].filter(Boolean).join(' · ')}
    onClick={() => nav.push('netServer', { key: s.key, name: s.name })}
    end={owner ? <Act kind="ghost" onClick={() => act('net.reset', { kind: 's', id: s.key }, { confirm: `Clear every network stat of ${s.name}? The ranking rebuilds from new reports.`, done: 'Server stats cleared' })}>Clear</Act> : null} />;
  const best = c.servers.slice(0, 5), weak = c.servers.length > 5 ? c.servers.slice(-3).reverse() : [];
  return (
    <Page title={c.isp} sub={`AS${c.asn} · ${plural(c.tests, 'test')}`} nav={nav}>
      <Section title="Best servers" />
      <List>{best.map((s) => srv(s, true))}</List>
      {weak.length ? (<><Section title="Weakest" /><List>{weak.map((s) => srv(s, false))}</List></>) : null}
      {owner ? (
        <div style={{ marginTop: '16px' }}>
          <Button kind="ghost" onClick={() => act('net.reset', { kind: 'a', id: String(c.asn) }, { confirm: `Clear every stat of ${c.isp}? The ranking rebuilds from new reports.`, done: 'Carrier stats cleared', after: () => nav.pop() })}>Clear this carrier's stats</Button>
        </div>
      ) : null}
    </Page>
  );
}
