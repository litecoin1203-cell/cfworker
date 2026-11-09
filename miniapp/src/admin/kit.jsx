// What every admin screen uses: loading a screen's data, running an action (confirm, toast, undo), the page frame.
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { admin } from './api.js';
import { toast, confirmDialog, Skeleton, ErrorState, Title } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { haptic } from '../tg.js';

// data for one screen; reload() fetches again without blanking what is shown
export function useLoad(fn, deps = []) {
  const [st, setSt] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const run = useCallback(async (quiet) => {
    if (!quiet) setSt((s) => ({ ...s, loading: true, error: null }));
    try { const data = await fn(); if (alive.current) setSt({ data, error: null, loading: false }); } catch (e) { if (alive.current) setSt((s) => ({ ...s, error: e, loading: false })); }
  }, deps);
  useEffect(() => { alive.current = true; run(); return () => { alive.current = false; }; }, [run]);
  return { ...st, reload: () => run(true) };
}

// the bot's money and destructive actions: the server refuses them without confirm, so the page always asks
export const NEEDS_CONFIRM = new Set(['user.grant', 'user.link', 'user.reset_password', 'user.reset_usage', 'user.wallet', 'order.approve', 'order.refund',
  'coupon.delete', 'panel.drain', 'user.end', 'user.unlink_tg', 'user.unlink_panel', 'user.delete', 'plan.delete', 'net.reset', 'broadcast.start']);

// Runs one admin action the way the bot does. opts.confirm = the question (asked for money / destructive ones),
// opts.done = the toast, opts.after = what to refresh. Resolves with the server's answer, or null.
export async function act(name, args, opts = {}) {
  const needs = NEEDS_CONFIRM.has(name);
  if (needs || opts.confirm) {
    const ok = await confirmDialog(opts.confirm || 'Are you sure?');
    if (!ok) return null;
  }
  let r;
  try { r = await admin.action(name, args, needs || !!opts.confirm); } catch (e) { haptic('error'); toast(e.message, { bad: true }); return null; }
  if (!r || r.ok === false) { haptic('error'); toast((r && r.error) || 'It did not work.', { bad: true }); return null; }
  haptic('success');
  const after = opts.after || (() => {});
  toast(opts.done || 'Done', {
    undo: r.undoable && r.audit_id ? async () => {
      try {
        const u = await admin.undo(r.audit_id);
        if (u.ok) { toast('Undone'); haptic('success'); } else toast(u.error, { bad: true });
      } catch (e) { toast(e.message, { bad: true }); }
      after();
    } : null,
  });
  after(r);
  return r;
}

// a page: title (with a back arrow below the first screen of a tab), then the screen's own content
export function Page({ title, sub, nav, right, children }) {
  return (
    <div class="fade">
      <BackBar nav={nav} />
      <Title title={title} sub={sub}>{right}</Title>
      {children}
    </div>
  );
}

export function BackBar({ nav }) {
  if (!nav || nav.depth <= 1) return null;
  return (
    <button type="button" class="iconbtn" style={{ marginLeft: '-10px' }} aria-label="Back" onClick={nav.pop}><Icon name="back" /></button>
  );
}

// what a screen shows while loading or after a failure
export function Loading({ st, hero, rows = 4, children }) {
  if (st.loading && !st.data) return <Skeleton hero={hero} rows={rows} />;
  if (st.error && !st.data) return <ErrorState message={st.error.message} onRetry={st.reload} />;
  return children(st.data);
}
