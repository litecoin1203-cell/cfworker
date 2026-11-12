// Home: like Pleat's Home, one big number for the thing that needs the admin most, the panels' state in a pill,
// three figures in a strip, then what is waiting. More: every other section of the bot, one row each.
import { useEffect } from 'preact/hooks';
import { admin } from './api.js';
import { useLoad, Loading } from './kit.jsx';
import { Hero, List, Row, Section, Avatar, Act } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, short, ROLE, plural } from './fmt.js';

const greet = (h = new Date().getHours()) => (h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

function PanelPill({ panels, onOpen }) {
  const live = panels.filter((p) => p.state !== 'disabled');
  const bad = live.filter((p) => p.create_error || (p.state !== 'new' && Number(p.health) < 50));
  const text = !live.length ? 'No panel yet' : bad.length ? `${bad[0].label}: needs a look${bad.length > 1 ? ` (+${bad.length - 1})` : ''}` : `${plural(live.length, 'panel')} healthy`;
  return (
    <button type="button" class="statuspill" onClick={onOpen}>
      <span class={'dot ' + (!live.length ? 'warn' : bad.length ? 'bad' : 'ok')} /><span>{text}</span>
    </button>
  );
}

export function Home({ nav }) {
  const st = useLoad(() => admin.dashboard(), []);
  useEffect(() => { if (st.data) nav.setBadge(st.data.review || 0); }, [st.data]);
  const support = nav.role === 'support';
  return (
    <Loading st={st} hero rows={3}>
      {(d) => {
        const waiting = [
          d.coin ? { icon: 'coin', title: `${plural(d.coin, 'crypto deposit')} found`, sub: 'Seen on the blockchain, waiting for you', go: () => nav.go('receipts', null) } : null,
          !support && d.sms ? { icon: 'message', title: `${plural(d.sms, 'bank SMS', 'bank SMS')} without an order`, sub: 'Last 7 days: no order, several orders, or not activated', go: () => nav.push('sms', { filter: 'un' }) } : null,
          !support && d.perr ? { icon: 'warn', title: `${plural(d.perr, 'panel')} refusing new accounts`, sub: 'Open the panel to see the error', go: () => nav.push('panels') } : null,
          !support && d.ending ? { icon: 'clock', title: `${plural(d.ending, 'plan')} ending in 3 days`, sub: 'A good moment to remind them', go: () => nav.go('users', null) } : null,
        ].filter(Boolean);
        return (
          <>
            <div class="hello">
              <Avatar label={nav.me.name} />
              <div class="t"><b>{greet()}, {first(nav.me.name)}</b><small>{ROLE[nav.role]}{d.panels && d.panels.length ? ` · ${plural(d.panels.length, 'panel')}` : ''}</small></div>
              <button type="button" class="iconbtn" aria-label="Receipts" onClick={() => nav.go('receipts')}><Icon name="bell" />{d.review ? <i class="dot" /> : null}</button>
            </div>
            {d.review ? (
              <Hero label="Receipts to review" num={n(d.review)} unit={d.review === 1 ? 'receipt' : 'receipts'} cta="Review now" onCta={() => nav.go('receipts')}
                pill={support ? null : <PanelPill panels={d.panels} onOpen={() => nav.push('panels')} />} />
            ) : (
              <Hero label="Active subscriptions" num={n(d.active)} unit="active" cta={support ? 'Open orders' : 'Find a user'} onCta={() => nav.go(support ? 'receipts' : 'users')}
                pill={support ? null : <PanelPill panels={d.panels} onOpen={() => nav.push('panels')} />} />
            )}
            <div class="strip">
              <button type="button" onClick={() => !support && nav.push('stats', { days: 1 })}><b>{short(d.sales_today)}</b><span>Sales today</span></button>
              <button type="button" onClick={() => !support && nav.push('stats', { days: 7 })}><b>{short(d.sales_week)}</b><span>This week</span></button>
              <button type="button" onClick={() => !support && nav.go('users')}><b>{d.new_week ? '+' : ''}{n(d.new_week)}</b><span>New users</span></button>
            </div>
            <Section title="Needs you" />
            <List>
              {waiting.length ? waiting.map((w) => <Row icon={w.icon} title={w.title} sub={w.sub} onClick={w.go} chevron />)
                : <Row icon="check" title="All clear" sub={d.review ? 'Only the receipts above are waiting.' : 'Nothing is waiting for you.'} />}
            </List>
            {!support ? (
              <>
                <Section title="Shortcuts" />
                <List>
                  <Row icon="users" title="Users" sub={`${n(d.users)} accounts · ${n(d.active)} active`} end={<Act onClick={() => nav.go('users')}>Open</Act>} onClick={() => nav.go('users')} />
                  <Row icon="megaphone" title="Broadcast" sub="Send a message to your Telegram users" end={<Act onClick={() => nav.push('broadcasts')}>Write</Act>} onClick={() => nav.push('broadcasts')} />
                  <Row icon="chart" title="Stats" sub="Sales, sign-ups and best plans" end={<Act onClick={() => nav.push('stats')}>View</Act>} onClick={() => nav.push('stats')} />
                  <Row icon="cloud" title="Cloudflare" sub="Today's Free plan use, errors and CPU" end={<Act onClick={() => nav.push('cloud')}>View</Act>} onClick={() => nav.push('cloud')} />
                  <Row icon="heart" title="App health" sub="Crashes and problems from users' phones" end={<Act onClick={() => nav.push('reports')}>View</Act>} onClick={() => nav.push('reports')} />
                </List>
              </>
            ) : null}
          </>
        );
      }}
    </Loading>
  );
}

const SECTIONS = [
  { title: 'Sales', rows: [
    { s: 'plans', icon: 'box', title: 'Plans', sub: 'Price, data, days, order in the app' },
    { s: 'coupons', icon: 'tag', title: 'Discount codes', sub: 'Codes, uses, expiry' },
    { s: 'referral', icon: 'gift', title: 'Referral reward', sub: 'What inviting a friend earns' },
    { s: 'payments', icon: 'card', title: 'Payment methods', sub: 'Card, bank SMS, crypto wallets, dollar price' },
  ] },
  { title: 'Network', rows: [
    { s: 'panels', icon: 'layers', title: 'Panels and servers', sub: 'Add, test, roll out, rename, hide' },
    { s: 'app', icon: 'phone', title: 'Pleat app', sub: 'Announcement, domains, bridges, trial, updates' },
    { s: 'net', icon: 'wifi', title: 'Carriers and ranking', sub: 'Best servers per operator, Google check' },
  ] },
  { title: 'Monitoring', rows: [
    { s: 'cloud', icon: 'cloud', title: 'Cloudflare', sub: 'Free plan use, errors, CPU, capacity, deploys' },
    { s: 'reports', icon: 'heart', title: 'App health', sub: 'Crashes and connection problems from users\' phones' },
    { s: 'health', icon: 'pulse', title: 'System health', sub: 'Webhook, panel sync, sync now' },
  ] },
  { title: 'Reach and reports', rows: [
    { s: 'broadcasts', icon: 'megaphone', title: 'Broadcast', sub: 'A message to your Telegram users' },
    { s: 'stats', icon: 'chart', title: 'Stats', sub: 'Today, 7 and 30 days' },
  ] },
  { title: 'System', rows: [
    { s: 'audit', icon: 'history', title: 'Admin log', sub: 'Every change, with undo for 10 minutes' },
    { s: 'admins', icon: 'shield', title: 'Admins', sub: 'Support and viewer roles', owner: true },
    { s: 'settings', icon: 'settings', title: 'All settings', sub: 'Every value, with history', owner: true },
  ] },
];

export function More({ nav }) {
  const owner = nav.role === 'owner';
  return (
    <div class="fade">
      <header class="title"><h1>More</h1></header>
      {SECTIONS.map((sec) => (
        <>
          <Section title={sec.title} />
          <List>{sec.rows.filter((r) => owner || !r.owner).map((r) => <Row icon={r.icon} title={r.title} sub={r.sub} onClick={() => nav.push(r.s)} chevron />)}</List>
        </>
      ))}
      <Section title="You" />
      <List>
        {owner ? <Row icon="download" title="Send a backup" sub="The database as a file, to your Telegram" onClick={() => nav.push('system')} chevron /> : null}
        <Row icon="switch" title="Open my own account" sub="See Pleat the way a user does" onClick={nav.onSwitch} chevron />
      </List>
    </div>
  );
}
