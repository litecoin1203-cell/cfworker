import { render } from 'preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { ready, haptic } from './tg.js';
import { signIn, createAccount, me } from './api.js';
import { gb, money, statusOf, pleatsLeft, dayDots, firstName } from './format.js';
import { Header, Card, Button, Chip, Pleats, Dots, Skeleton, ErrorState, EmptyState } from './ui.jsx';
import { AdminApp } from './admin/App.jsx';

function Welcome({ name, onCreate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await createAccount(); haptic('success'); onCreate(); } catch (e) { haptic('error'); setError(e.message); setBusy(false); }
  };
  return (
    <EmptyState title={name ? `Welcome, ${firstName(name)}` : 'Welcome to Pleat'}
      text="Create your Pleat account with your Telegram. No password needed.">
      <Button onClick={go} busy={busy}>Create account</Button>
      {error ? <p class="err" role="alert">{error}</p> : null}
    </EmptyState>
  );
}

function PlanCard({ sub }) {
  const st = statusOf(sub);
  const dots = dayDots(sub);
  const left = sub.unlimited_data ? '∞' : gb(sub.remaining_bytes);
  return (
    <Card class="plan">
      <div class="row"><span class="label">{sub.plan_name || 'Your plan'}</span><Chip tone={st.tone}>{st.label}</Chip></div>
      <div class="big"><b>{left}</b><span>{sub.unlimited_data ? 'data' : 'GB left'}</span></div>
      <Pleats left={pleatsLeft(sub)} />
      {!sub.unlimited_data ? <p class="sub">{gb(sub.used_bytes)} of {gb(sub.data_limit_bytes)} GB used</p> : null}
      <div class="row days">
        <span class="label">{sub.unlimited_time ? 'No end date' : `${sub.days_left} ${sub.days_left === 1 ? 'day' : 'days'} left`}</span>
        {sub.expires_at ? <span class="sub">until {new Date(sub.expires_at).toISOString().slice(0, 10)}</span> : null}
      </div>
      {dots ? <Dots total={dots.total} left={dots.left} /> : null}
    </Card>
  );
}

function Home({ data }) {
  const sub = data.subscription;
  return (
    <>
      {sub ? <PlanCard sub={sub} /> : (
        <EmptyState title="No plan yet" text="Buying plans here is coming soon. For now, buy a plan in the Pleat app." />
      )}
      <Card class="line">
        <span class="label">Wallet</span><span><b>{money(data.wallet_balance)}</b> toman</span>
      </Card>
      <Card class="line note">
        <span>To connect, open the <b>Pleat</b> app and tap Connect.</span>
      </Card>
    </>
  );
}

let userView = false;

function App() {
  const [state, setState] = useState({ phase: 'loading' });
  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const s = await signIn();
      // admins land on the admin panel (their own account is one tap away)
      if (s.admin && !userView) return setState({ phase: 'admin' });
      if (s.need_account) return setState({ phase: 'welcome', name: s.name });
      const data = await me();
      setState({ phase: 'home', data });
    } catch (e) {
      setState({ phase: 'error', code: e.code, message: e.message });
    }
  }, []);
  useEffect(() => { ready().then(load); }, []);

  if (state.phase === 'admin') return <AdminApp onSwitch={() => { userView = true; document.documentElement.dir = 'ltr'; document.documentElement.lang = 'en'; load(); }} />;
  const name = state.phase === 'home' ? ((state.data.telegram && state.data.telegram.name) || '') : '';
  let body;
  if (state.phase === 'loading') body = <Skeleton />;
  else if (state.phase === 'welcome') body = <Welcome name={state.name} onCreate={load} />;
  else if (state.phase === 'home') body = <Home data={state.data} />;
  else if (state.code === 'no_telegram') body = <EmptyState title="Open Pleat in Telegram" text="This page works inside the Pleat bot. Open the bot and tap the Pleat button." />;
  else body = <ErrorState title="Pleat could not load" text={state.message} onRetry={load} />;

  return (
    <main>
      <Header name={name} />
      <div class="stack" aria-live="polite">{body}</div>
    </main>
  );
}

render(<App />, document.getElementById('root'));
