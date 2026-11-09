// The admin panel: four tabs like Pleat's bottom bar (Home, Receipts, Users, More), each with its own stack of
// screens. Telegram's BackButton and the page's back arrow pop the stack. English, left to right.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { admin } from './api.js';
import { Icon } from '../icons.jsx';
import { Overlays, Skeleton, ErrorState } from '../ui.jsx';
import { webApp, haptic } from '../tg.js';
import { Home, More } from './home.jsx';
import { Receipts, OrderDetail } from './orders.jsx';
import { Users, UserCard, UserWallet, UserOrders, UserNets } from './users.jsx';
import { Plans, PlanDetail, Coupons, CouponDetail, Referral, Payments, Coins, SmsLog } from './sales.jsx';
import { Panels, PanelDetail, PanelServers, AppSettings, Network, Carrier } from './infra.jsx';
import { Broadcasts, BroadcastDetail, Stats, System, Health, Audit, Admins, Settings } from './system.jsx';

const SCREENS = {
  home: Home, more: More, receipts: Receipts, order: OrderDetail,
  users: Users, user: UserCard, userWallet: UserWallet, userOrders: UserOrders, userNets: UserNets,
  plans: Plans, plan: PlanDetail, coupons: Coupons, coupon: CouponDetail, referral: Referral, payments: Payments, coins: Coins, sms: SmsLog,
  panels: Panels, panel: PanelDetail, servers: PanelServers, app: AppSettings, net: Network, carrier: Carrier,
  broadcasts: Broadcasts, broadcast: BroadcastDetail, stats: Stats, system: System, health: Health, audit: Audit, admins: Admins, settings: Settings,
};

const TABS = [
  { k: 'home', label: 'Home', icon: 'home', root: 'home' },
  { k: 'receipts', label: 'Receipts', icon: 'receipt', root: 'receipts' },
  { k: 'users', label: 'Users', icon: 'users', root: 'users' },
  { k: 'more', label: 'More', icon: 'grid', root: 'more' },
];
// support admins handle receipts and orders only (the bot's SUPPORT_ROUTES)
const SUPPORT_TABS = new Set(['home', 'receipts']);

function Shell({ me, onSwitch }) {
  const tabs = me.role === 'support' ? TABS.filter((t) => SUPPORT_TABS.has(t.k)) : TABS;
  const [tab, setTab] = useState('home');
  const [stacks, setStacks] = useState(() => Object.fromEntries(TABS.map((t) => [t.k, [{ s: t.root, p: {}, key: 1 }]])));
  const [badge, setBadge] = useState(0);
  const stack = stacks[tab];
  const top = stack[stack.length - 1];

  const push = useCallback((s, p = {}) => { haptic('light'); setStacks((x) => ({ ...x, [tab]: [...x[tab], { s, p, key: Date.now() }] })); scrollTo(0, 0); }, [tab]);
  const pop = useCallback(() => setStacks((x) => (x[tab].length > 1 ? { ...x, [tab]: x[tab].slice(0, -1) } : x)), [tab]);
  // a screen in another tab (e.g. Home -> a receipt); that tab starts from its root
  const go = useCallback((t, s, p = {}) => {
    haptic('light');
    setStacks((x) => ({ ...x, [t]: s ? [x[t][0], { s, p, key: Date.now() }] : [x[t][0]] }));
    setTab(t); scrollTo(0, 0);
  }, []);

  // Telegram's own back button follows the stack
  useEffect(() => {
    const bb = webApp() && webApp().BackButton;
    if (!bb) return undefined;
    try { if (stack.length > 1) { bb.show(); bb.onClick(pop); } else bb.hide(); } catch (e) { /* older clients */ }
    return () => { try { bb.offClick(pop); } catch (e) { /* ignore */ } };
  }, [stack.length, pop]);

  const Screen = SCREENS[top.s] || Home;
  const nav = { push, pop, go, depth: stack.length, role: me.role, me, onSwitch, setBadge };
  return (
    <>
      <main class="page" key={tab + top.key}><Screen p={top.p} nav={nav} /></main>
      <nav class="nav" aria-label="Sections">
        {tabs.map((t) => (
          <button type="button" class={tab === t.k ? 'on' : ''} aria-current={tab === t.k ? 'page' : undefined}
            onClick={() => { if (tab === t.k) go(t.k); else { haptic('light'); setTab(t.k); } }}>
            <span class="bub"><Icon name={t.icon} size={tab === t.k ? 24 : 22} /></span>
            {t.k === 'receipts' && badge ? <span class="badge">{badge > 99 ? '99+' : badge}</span> : null}
            {t.label}
          </button>
        ))}
      </nav>
      <Overlays />
    </>
  );
}

export function AdminApp({ onSwitch }) {
  const [st, setSt] = useState({ phase: 'loading' });
  const load = async () => {
    setSt({ phase: 'loading' });
    try { setSt({ phase: 'ready', me: await admin.auth() }); } catch (e) { setSt({ phase: 'error', message: e.message }); }
  };
  useEffect(() => {
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = 'en';
    load();
  }, []);
  if (st.phase === 'loading') return <main class="page nonav"><Skeleton hero rows={3} /></main>;
  if (st.phase === 'error') return <main class="page nonav"><ErrorState message={st.message} onRetry={load} /></main>;
  return <Shell me={st.me} onSwitch={onSwitch} />;
}
