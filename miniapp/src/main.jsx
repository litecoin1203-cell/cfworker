import { render } from 'preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { ready, haptic } from './tg.js';
import { signIn, createAccount, me, deleteAccount } from './api.js';
import { gb, money, statusOf, pleatsLeft, dayDots, firstName, planLabel } from './format.js';
import { Mark, Avatar, Hero, Button, Tag, Pleats, Dots, List, Row, Section, Skeleton, ErrorState, EmptyState, Overlays, openForm } from './ui.jsx';
import { AdminApp } from './admin/App.jsx';

const TONE = { safe: 'ok', alert: 'bad', muted: '' };

function Welcome({ name, onCreate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await createAccount(); haptic('success'); onCreate(); } catch (e) { haptic('error'); setError(e.message); setBusy(false); }
  };
  return (
    <EmptyState icon="user" title={name ? `Welcome, ${firstName(name)}` : 'Welcome to Pleat'}
      text="Create your Pleat account with your Telegram. No password needed.">
      <Button onClick={go} busy={busy}>Create account</Button>
      {error ? <p class="err" role="alert">{error}</p> : null}
    </EmptyState>
  );
}

function PlanCard({ sub }) {
  const st = statusOf(sub);
  const dots = dayDots(sub);
  return (
    <div class="card">
      <div class="cap">{planLabel(sub)} <span class="of"><Tag tone={TONE[st.tone]}>{st.label}</Tag></span></div>
      <Pleats left={pleatsLeft(sub, 12)} total={12} />
      {!sub.unlimited_data ? <p class="note">{gb(sub.used_bytes)} of {gb(sub.data_limit_bytes)} GB used</p> : <p class="note">Unlimited data</p>}
      <div class="cap" style={{ marginTop: '14px' }}>{sub.unlimited_time ? 'No end date' : `${sub.days_left} ${sub.days_left === 1 ? 'day' : 'days'} left`}
        {sub.expires_at ? <span class="of note">until {new Date(sub.expires_at).toISOString().slice(0, 10)}</span> : null}</div>
      {dots ? <Dots total={dots.total} left={dots.left} /> : null}
    </div>
  );
}

// PRV-04: the account is deleted for good after the word DELETE is typed; what is lost is said first
async function askDelete(onDeleted) {
  const v = await openForm({
    title: 'Delete account', danger: true, submit: 'Delete',
    lead: 'This can’t be undone. Your plan ends now, and its remaining days and data, and any wallet balance, are lost. '
      + 'Your Telegram link, character and devices are erased and every phone is signed out. Orders and wallet history are kept for accounting.',
    fields: [{ key: 'confirm', label: 'Type DELETE to confirm', required: true, placeholder: 'DELETE' }],
    onSubmit: async (x) => { await deleteAccount(x.confirm); },
  });
  if (v) { haptic('success'); onDeleted(); }
}

function Home({ data, onDeleted }) {
  const sub = data.subscription;
  const name = (data.telegram && data.telegram.name) || '';
  return (
    <>
      <div class="hello">
        <Avatar label={name || 'P'} />
        <div class="t"><b>Hi, {firstName(name) || 'there'}</b><small>Your Pleat account</small></div>
        <Mark />
      </div>
      {sub ? (
        <>
          <Hero label="Data left" num={sub.unlimited_data ? '∞' : gb(sub.remaining_bytes)} unit={sub.unlimited_data ? 'data' : 'GB'} />
          <PlanCard sub={sub} />
        </>
      ) : <EmptyState icon="box" title="No plan yet" text="Buying plans here is coming soon. For now, buy a plan in the Pleat app." />}
      <Section title="Account" />
      <List>
        <Row icon="wallet" title="Wallet" sub="Top up and pay in the Pleat app" end={<b>{money(data.wallet_balance)} toman</b>} />
        <Row icon="phone" title="Connect" sub="Open the Pleat app and tap Connect" />
        <Row icon="close" title="Delete account" sub="Erases your account for good" danger onClick={() => askDelete(onDeleted)} chevron />
      </List>
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

  if (state.phase === 'admin') return <AdminApp onSwitch={() => { userView = true; load(); }} />;
  let body;
  if (state.phase === 'loading') body = <Skeleton />;
  else if (state.phase === 'welcome') body = <Welcome name={state.name} onCreate={load} />;
  else if (state.phase === 'home') body = <Home data={state.data} onDeleted={() => setState({ phase: 'deleted' })} />;
  else if (state.phase === 'deleted') body = <EmptyState icon="check" title="Account deleted" text="Your Pleat account was deleted. You can close this page." />;
  else if (state.code === 'no_telegram') body = <EmptyState title="Open Pleat in Telegram" text="This page works inside the Pleat bot. Open the bot and tap the Pleat button." />;
  else body = <ErrorState message={state.message} onRetry={load} />;

  return (
    <main class="page nonav" aria-live="polite">
      <div class="fade">{body}</div>
      <Overlays />
    </main>
  );
}

document.documentElement.dir = 'ltr';
document.documentElement.lang = 'en';
render(<App />, document.getElementById('root'));
