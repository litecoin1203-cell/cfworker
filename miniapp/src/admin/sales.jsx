// Sales: plans (every field, order in the app, on/off, copy, archive), discount codes, the referral reward and the
// payment methods (card, bank SMS, crypto wallets, dollar price, payment settings, the SMS log).
import { useState } from 'preact/hooks';
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Chips, Tag, Act, Button, EmptyState, KV, openForm, toast, Toggle } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, day, ago, plural, AUTO, SMS_RESULT } from './fmt.js';

const setting = (key, val, done, after) => act('setting.set', { key, val: String(val) }, { done, after });

// ---------------- plans ----------------
const PLAN_FIELDS = [
  { f: 'name', label: 'Name', get: (p) => p.name, type: 'text', show: (p) => p.name },
  { f: 'price', label: 'Price (toman)', get: (p) => p.price, type: 'number', show: (p) => `${n(p.price)} toman` },
  { f: 'old', label: 'Old price (shown struck out)', get: (p) => p.old_price, type: 'number', show: (p) => (p.old_price ? `${n(p.old_price)} toman` : 'None') },
  { f: 'days', label: 'Days', get: (p) => p.days, type: 'number', show: (p) => plural(p.days, 'day') },
  { f: 'gb', label: 'Data (GB, 0 = unlimited)', get: (p) => p.gb, type: 'number', show: (p) => (p.gb ? `${p.gb} GB` : 'Unlimited') },
  { f: 'devices', label: 'Devices (0 = unlimited)', get: (p) => p.devices, type: 'number', show: (p) => (p.devices ? String(p.devices) : 'Unlimited') },
  { f: 'trial', label: 'Free trial days (0 = none)', get: (p) => p.trial_days, type: 'number', show: (p) => (p.trial_days ? plural(p.trial_days, 'day') : 'None') },
  { f: 'badge', label: 'Badge', get: (p) => p.badge, type: 'text', show: (p) => p.badge || 'None' },
  { f: 'desc', label: 'Description', get: (p) => p.description, type: 'textarea', show: (p) => p.description || 'None' },
];

async function newPlanForm(nav, after) {
  await openForm({
    title: 'New plan', submit: 'Create',
    fields: [{ key: 'name', label: 'Name', required: true, placeholder: 'Monthly 50 GB', max: 60 }, { key: 'days', label: 'Days', type: 'number', required: true, quick: [{ value: 30, label: '30' }, { value: 90, label: '90' }] },
      { key: 'gb', label: 'Data (GB, 0 = unlimited)', type: 'number', value: '50' }, { key: 'devices', label: 'Devices (0 = unlimited)', type: 'number', value: '0' },
      { key: 'price', label: 'Price (toman)', type: 'number', required: true }],
    onSubmit: async (v) => {
      const r = await admin.action('plan.create', { name: v.name.trim(), days: v.days, gb: v.gb || 0, devices: v.devices || 0, price: v.price });
      if (!r.ok) throw new Error(r.error);
      toast('Plan created'); after();
      if (r.target_id) nav.push('plan', { id: r.target_id });
    },
  });
}

export function Plans({ nav }) {
  const st = useLoad(() => admin.plans(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Plans" sub="In this order in the app" nav={nav} right={owner ? <button type="button" class="iconbtn" aria-label="New plan" onClick={() => newPlanForm(nav, st.reload)}><Icon name="plus" /></button> : null}>
      <Loading st={st} rows={4}>
        {(d) => {
          const live = d.plans.filter((p) => !p.archived), arch = d.plans.filter((p) => p.archived);
          return (
            <>
              {live.length ? (
                <List>{live.map((p) => <Row icon="box" title={p.name} sub={`${n(p.price)} toman · ${p.gb ? p.gb + ' GB' : 'unlimited'} · ${p.days} days${p.trial_days ? ` · ${p.trial_days}-day trial` : ''} · sold ${n(p.sold)}`}
                  end={<Tag tone={p.on ? 'ok' : ''}>{p.on ? 'On' : 'Off'}</Tag>} onClick={() => nav.push('plan', { id: p.id })} />)}</List>
              ) : <EmptyState icon="box" title="No plans yet" text="Create the first plan with the + button." />}
              {arch.length ? (
                <>
                  <Section title="Archived" />
                  <p class="note" style={{ marginBottom: '8px' }}>Removed plans that had orders. Not in the app; their names stay in the history.</p>
                  <List>{arch.map((p) => <Row icon="box" title={p.name} sub={`${n(p.price)} toman · sold ${n(p.sold)}`} end={<Tag>Archived</Tag>} onClick={() => nav.push('plan', { id: p.id })} />)}</List>
                </>
              ) : null}
            </>
          );
        }}
      </Loading>
    </Page>
  );
}

export function PlanDetail({ p, nav }) {
  const st = useLoad(async () => (await admin.plans()).plans.find((x) => x.id === p.id) || null, [p.id]);
  const owner = nav.role === 'owner';
  const edit = async (plan, fd) => {
    const v = await openForm({ title: fd.label, submit: 'Save', fields: [{ key: 'raw', label: fd.label, type: fd.type, value: String(fd.get(plan) ?? ''), max: fd.f === 'desc' ? 600 : 80 }] });
    if (v) act('plan.set', { id: plan.id, field: fd.f, raw: v.raw }, { done: `${fd.label.split(' (')[0]} saved`, after: st.reload });
  };
  return (
    <Loading st={st} rows={5}>
      {(plan) => (!plan ? <EmptyState icon="box" title="Plan not found" /> : (
        <Page title={plan.name} sub={plan.archived ? 'Archived' : plan.on ? 'On, shown in the app' : 'Off'} nav={nav}>
          <div class="card">
            <div class="cap">Price</div>
            <div class="disp" style={{ marginBottom: 4 }}><b>{n(plan.price)}</b><span>toman</span>{plan.old_price ? <span class="of" style={{ textDecoration: 'line-through' }}>{n(plan.old_price)}</span> : null}</div>
            <KV k="Sold">{plural(plan.sold, 'time')} · {n(plan.income)} toman</KV>
          </div>
          <Section title="Details" />
          <List>{PLAN_FIELDS.map((fd) => <Row title={fd.label.split(' (')[0]} sub={fd.show(plan)} onClick={owner ? () => edit(plan, fd) : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />)}</List>
          {owner ? (
            <>
              <Section title="Actions" />
              <List>
                {!plan.archived ? (
                  <>
                    <Row icon={plan.on ? 'eyeOff' : 'eye'} title={plan.on ? 'Turn off' : 'Turn on'} sub={plan.on ? 'Hidden in the app, nothing else changes' : 'Shown in the app again'} end={<Toggle on={plan.on} label="Shown in the app" onChange={() => act('plan.toggle', { id: plan.id }, { done: plan.on ? 'Turned off' : 'Turned on', after: st.reload })} />} />
                    <Row icon="up" title="Move up" onClick={() => act('plan.move', { id: plan.id, dir: 'u' }, { done: 'Moved up', after: st.reload })} />
                    <Row icon="down" title="Move down" onClick={() => act('plan.move', { id: plan.id, dir: 'd' }, { done: 'Moved down', after: st.reload })} />
                  </>
                ) : <Row icon="undo" title="Restore from archive" sub="Comes back turned off" onClick={() => act('plan.unarchive', { id: plan.id }, { done: 'Restored', after: st.reload })} chevron />}
                <Row icon="copy" title="Copy" sub="A new plan with the same values, turned off" onClick={() => act('plan.copy', { id: plan.id }, { done: 'Copied', after: () => nav.pop() })} chevron />
                {!plan.archived ? <Row icon="trash" title="Remove" sub="Archived if anyone bought it, deleted if not" danger onClick={() => act('plan.delete', { id: plan.id }, { confirm: `Remove "${plan.name}"? If it has orders it is archived (out of the app), otherwise deleted.`, done: 'Removed', after: () => nav.pop() })} chevron /> : null}
                <Row icon="history" title="History" onClick={() => nav.push('audit', { type: 'plan', id: String(plan.id) })} chevron />
              </List>
            </>
          ) : null}
        </Page>
      ))}
    </Loading>
  );
}

// ---------------- coupons ----------------
async function couponForm(after, nav) {
  const plans = (await admin.plans()).plans.filter((x) => !x.archived);
  await openForm({
    title: 'New discount code', submit: 'Create',
    fields: [{ key: 'code', label: 'Code', required: true, placeholder: 'YALDA', max: 32, hint: 'Letters, digits, - and _. Saved in capitals.' },
      { key: 'percent', label: 'Discount %', type: 'number', required: true, quick: [10, 20, 30, 50].map((x) => ({ value: x, label: x + '%' })) },
      { key: 'uses', label: 'Uses (0 = no limit)', type: 'number', value: '0', quick: [{ value: 10, label: '10' }, { value: 100, label: '100' }] },
      { key: 'days', label: 'Valid for days (0 = always)', type: 'number', value: '0', quick: [{ value: 7, label: '7' }, { value: 30, label: '30' }] },
      { key: 'planId', label: 'Plan', type: 'select', value: '0', options: [{ value: '0', label: 'Every plan' }, ...plans.map((x) => ({ value: String(x.id), label: x.name }))] }],
    onSubmit: async (v) => {
      const r = await admin.action('coupon.create', { code: v.code.trim(), percent: v.percent, uses: v.uses || 0, days: v.days || 0, planId: parseInt(v.planId, 10) || null });
      if (!r.ok) throw new Error(r.error);
      toast('Code created'); after();
    },
  });
}

const couponSub = (c) => `${c.percent}% off · used ${n(c.used)}${c.max_uses ? ' of ' + n(c.max_uses) : ''}${c.expires_at ? ` · ${c.expires_at > Date.now() / 1000 ? 'until ' + day(c.expires_at) : 'expired'}` : ''}${c.plan ? ' · ' + c.plan : ''}`;

export function Coupons({ nav }) {
  const st = useLoad(() => admin.coupons(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Discount codes" nav={nav} right={owner ? <button type="button" class="iconbtn" aria-label="New code" onClick={() => couponForm(st.reload, nav)}><Icon name="plus" /></button> : null}>
      <Loading st={st} rows={4}>
        {(d) => (d.coupons.length ? (
          <List>{d.coupons.map((c) => <Row icon="tag" title={<span class="mono" style={{ fontSize: '15px' }}>{c.code}</span>} sub={couponSub(c)} end={<Tag tone={c.on ? 'ok' : ''}>{c.on ? 'On' : 'Paused'}</Tag>} onClick={() => nav.push('coupon', { id: c.id, c })} />)}</List>
        ) : <EmptyState icon="tag" title="No codes yet" text="Create one with the + button." />)}
      </Loading>
      <Section title="Related" />
      <List><Row icon="gift" title="Referral reward" sub="What inviting a friend earns" onClick={() => nav.push('referral')} chevron /></List>
    </Page>
  );
}

export function CouponDetail({ p, nav }) {
  const st = useLoad(async () => (await admin.coupons()).coupons.find((c) => c.id === p.id) || p.c, [p.id]);
  const uses = useLoad(() => admin.couponUses(p.id), [p.id]);
  const owner = nav.role === 'owner';
  const set = async (c, field, label, value, quick) => {
    const v = await openForm({ title: label, submit: 'Save', fields: [{ key: 'v', label, type: 'number', value: String(value), quick }] });
    if (v) act('coupon.set', { id: c.id, field, value: v.v }, { done: `${label.split(' (')[0]} saved`, after: st.reload });
  };
  const planPick = async (c) => {
    const plans = (await admin.plans()).plans.filter((x) => !x.archived);
    const v = await openForm({ title: 'Plan', submit: 'Save', fields: [{ key: 'v', label: 'Accepted for', type: 'select', value: String(c.plan_id || 0), options: [{ value: '0', label: 'Every plan' }, ...plans.map((x) => ({ value: String(x.id), label: x.name }))] }] });
    if (v) act('coupon.set', { id: c.id, field: 'l', value: v.v }, { done: 'Plan saved', after: st.reload });
  };
  return (
    <Loading st={st} rows={4}>
      {(c) => (!c ? <EmptyState icon="tag" title="Code not found" /> : (
        <Page title={c.code} sub={c.on ? 'On' : 'Paused, not accepted in the app'} nav={nav}>
          <div class="card">
            <div class="cap">Discount</div>
            <div class="disp" style={{ marginBottom: 4 }}><b>{c.percent}</b><span>% off</span></div>
            <KV k="Paid orders with it">{n(c.paid)}</KV>
          </div>
          <Section title="Rules" />
          <List>
            <Row title="Discount" sub={`${c.percent}%`} onClick={owner ? () => set(c, 'p', 'Discount %', c.percent, [10, 20, 30, 50].map((x) => ({ value: x, label: x + '%' }))) : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
            <Row title="Uses" sub={`${n(c.used)} of ${c.max_uses ? n(c.max_uses) : 'no limit'}`} onClick={owner ? () => set(c, 'u', 'Uses (0 = no limit)', c.max_uses, [{ value: 0, label: 'No limit' }, { value: 10, label: '10' }, { value: 100, label: '100' }]) : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
            <Row title="Valid until" sub={c.expires_at ? day(c.expires_at) : 'Always'} onClick={owner ? () => set(c, 'd', 'Days from today (0 = always)', 0, [{ value: 0, label: 'Always' }, { value: 7, label: '7' }, { value: 30, label: '30' }]) : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
            <Row title="Plan" sub={c.plan || 'Every plan'} onClick={owner ? () => planPick(c) : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
          </List>
          {owner ? (
            <>
              <Section title="Actions" />
              <List>
                <Row icon={c.on ? 'pause' : 'play'} title={c.on ? 'Pause' : 'Turn on'} end={<Toggle on={c.on} label="Accepted" onChange={() => act('coupon.toggle', { id: c.id }, { done: c.on ? 'Paused' : 'Turned on', after: st.reload })} />} />
                <Row icon="history" title="History" onClick={() => nav.push('audit', { type: 'coupon', id: c.code })} chevron />
                <Row icon="trash" title="Delete code" danger onClick={() => act('coupon.delete', { code: c.code }, { confirm: `Delete code ${c.code}?`, done: 'Deleted', after: () => nav.pop() })} chevron />
              </List>
            </>
          ) : null}
          <Section title="Who used it" />
          <Loading st={uses} rows={2}>
            {(u) => (u.uses.length ? <List>{u.uses.map((x) => <Row icon="user" title={<bdi>{x.user}</bdi>} sub={`${day(x.created_at)}${x.order_id ? ` · order #${x.order_id}` : ''}`} onClick={() => nav.push('user', { id: x.user_id })} chevron />)}</List> : <p class="note">Nobody has bought with it yet.</p>)}
          </Loading>
        </Page>
      ))}
    </Loading>
  );
}

export function Referral({ nav }) {
  const st = useLoad(() => admin.referral(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Referral reward" nav={nav}>
      <Loading st={st} rows={3}>
        {(d) => (
          <>
            <div class="card">
              <div class="cap">Reward</div>
              <div class="disp" style={{ marginBottom: 4 }}><b>{d.percent}</b><span>% of every purchase</span></div>
              <p class="note" style={{ padding: 0 }}>{d.percent ? 'Goes to the inviter\'s wallet each time a friend they invited buys.' : 'Off. Nobody earns for inviting.'}</p>
            </div>
            {owner ? (
              <Chips items={[0, 5, 10, 15, 20].map((x) => ({ k: x, label: x ? x + '%' : 'Off' }))} value={d.percent} onChange={(v) => setting('referral_percent', v, `Reward: ${v ? v + '%' : 'off'}`, st.reload)} />
            ) : null}
            <Section title="Top inviters" />
            {d.top.length ? <List>{d.top.map((t, i) => <Row icon={i < 3 ? 'star' : 'user'} title={<bdi>{t.user}</bdi>} sub={`${plural(t.invited, 'friend')} · ${n(t.earned)} toman earned`} onClick={() => nav.push('user', { id: t.user_id })} chevron />)}</List> : <p class="note">Nobody has invited anyone yet.</p>}
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------- payments ----------------
const MODES = [{ k: 'auto', label: AUTO.auto }, { k: 'detect', label: AUTO.detect }, { k: 'off', label: AUTO.off }];

async function cardForm(d, after) {
  const v = await openForm({ title: 'Card', lead: 'Shown to users who pay card to card.', submit: 'Save',
    fields: [{ key: 'number', label: 'Card number', type: 'number', value: d.card.number, placeholder: '16 digits', max: 19 }, { key: 'holder', label: 'Card holder', value: d.card.holder, max: 60 }] });
  if (!v) return;
  if (v.number !== d.card.number) { const r = await act('setting.set', { key: 'card_number', val: v.number }, { done: 'Card number saved' }); if (!r) return; }
  if (v.holder !== d.card.holder) await act('setting.set', { key: 'card_holder', val: v.holder.trim() }, { done: 'Card holder saved' });
  after();
}

async function smsSetupSheet() {
  let s;
  try { s = await admin.smsSetup(); } catch (e) { toast(e.message, { bad: true }); return; }
  await openForm({
    title: 'Bank SMS forwarding', submit: 'Done',
    lead: 'On the phone that gets the bank SMS, install "Incoming SMS to URL forwarder" and add a rule with these. Keep them private: anyone with the key can send fake SMS.',
    fields: [{ key: 'u', label: 'URL', value: s.url }, { key: 'h', label: 'Header', value: `{"X-SMS-Key": "${s.header['X-SMS-Key']}"}` },
      { key: 'k', label: 'URL for apps without headers', value: s.url_with_key, hint: 'Works too, but the key stays in request logs.' }],
  });
}

async function rateSheet() {
  let r;
  try { r = await admin.rate(); } catch (e) { toast(e.message, { bad: true }); return; }
  await openForm({
    title: 'Dollar price now', submit: 'Close',
    lead: `${r.toman ? n(r.toman) + ' toman' : 'No price available'} · the median of the exchanges below; prices far from the rest are left out.`,
    fields: r.sources.map((x, i) => ({ key: 's' + i, label: x.name + (x.used ? '' : x.toman ? ' (left out)' : ' (no answer)'), value: x.toman ? n(x.toman) : (x.error || '—') })),
  });
}

export function Payments({ nav }) {
  const st = useLoad(() => admin.payments(), []);
  const owner = nav.role === 'owner';
  return (
    <Page title="Payment methods" nav={nav}>
      <Loading st={st} rows={5}>
        {(d) => (
          <>
            <Section title="Card to card" />
            <List>
              <Row icon="card" title={d.card.number ? d.card.number.replace(/(\d{4})(?=\d)/g, '$1 ') : 'No card yet'} sub={d.card.holder || 'Card holder not set'} onClick={owner ? () => cardForm(d, st.reload) : undefined} end={owner ? <Act>Edit</Act> : null} />
              <Row icon="message" title="Confirm by bank SMS" sub={`${AUTO[d.card_auto] || d.card_auto} · ${plural(d.sender_count, 'trusted sender')}`} />
            </List>
            {owner ? <Chips items={MODES} value={d.card_auto} onChange={(v) => setting('card_auto', v, `Card SMS: ${AUTO[v]}`, st.reload)} /> : null}
            <List>
              <Row icon="filter" title="Unique amount" sub="A few toman added to each card order so the SMS matches exactly one" end={owner ? <Toggle on={d.settings.card_unique} label="Unique amount" onChange={(v) => setting('card_unique', v ? '1' : '0', v ? 'Unique amount on' : 'Unique amount off', st.reload)} /> : <Tag>{d.settings.card_unique ? 'On' : 'Off'}</Tag>} />
              <Row icon="message" title="Bank SMS received" sub="What was read from each SMS" onClick={() => nav.push('sms', {})} chevron />
              {owner ? <Row icon="settings" title="Set up SMS forwarding" sub={d.sms_ready ? 'Ready. Tap to see the address again' : 'Not set up yet'} onClick={smsSetupSheet} chevron /> : null}
            </List>
            {owner && d.senders.length ? (
              <>
                <Section title="Trusted bank senders" />
                <List>{d.senders.map((x) => <Row icon="shield" title={<span class="mono">{x}</span>} end={<Act kind="danger" onClick={() => setting('sms_senders', d.senders.filter((y) => y !== x).join(','), 'Sender removed', st.reload)}>Remove</Act>} />)}</List>
                <p class="note" style={{ marginTop: '8px' }}>To add one: when a deposit SMS arrives in the bot, tap "this sender is my bank".</p>
              </>
            ) : null}
            <Section title="Crypto" />
            <List>
              <Row icon="coin" title="Wallets" sub={`${plural(d.coins.filter((c) => c.on).length, 'coin')} on of ${d.coins.length}`} onClick={() => nav.push('coins')} chevron />
              <Row icon="check" title="Confirm on the blockchain" sub={AUTO[d.coin_auto] || d.coin_auto} />
            </List>
            {owner ? <Chips items={MODES} value={d.coin_auto} onChange={(v) => setting('coin_auto', v, `Crypto: ${AUTO[v]}`, st.reload)} /> : null}
            <Section title="Settings" />
            <List>
              <Row icon="coin" title="Dollar price" sub={d.settings.usd_rate_toman ? `Manual: ${n(d.settings.usd_rate_toman)} toman` : `Automatic${d.rate ? ': ' + n(d.rate.toman) + ' toman' : ''}`}
                onClick={owner ? async () => {
                  const v = await openForm({ title: 'Dollar price', lead: '0 = automatic from the exchanges.', submit: 'Save', fields: [{ key: 'v', label: 'Toman per dollar', type: 'number', value: String(d.settings.usd_rate_toman), quick: [{ value: 0, label: 'Automatic' }] }] });
                  if (v) setting('usd_rate_toman', v.v || '0', 'Dollar price saved', st.reload);
                } : undefined} end={owner ? <Act onClick={rateSheet}>Live</Act> : null} />
              <Row icon="clock" title="Crypto payment time" sub={`${d.settings.coin_minutes} minutes`} onClick={owner ? async () => {
                const v = await openForm({ title: 'Crypto payment time', submit: 'Save', fields: [{ key: 'v', label: 'Minutes', type: 'select', value: String(d.settings.coin_minutes), options: ['15', '30', '60'].map((x) => ({ value: x, label: x + ' minutes' })) }] });
                if (v) setting('coin_minutes', v.v, 'Saved', st.reload);
              } : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
              <Row icon="wallet" title="Minimum wallet top-up" sub={`${n(d.settings.min_topup_toman)} toman`} onClick={owner ? async () => {
                const v = await openForm({ title: 'Minimum top-up', submit: 'Save', fields: [{ key: 'v', label: 'Toman', type: 'number', value: String(d.settings.min_topup_toman), quick: [20000, 50000, 100000].map((x) => ({ value: x, label: n(x) })) }] });
                if (v) setting('min_topup_toman', v.v, 'Saved', st.reload);
              } : undefined} end={owner ? <Icon name="edit" size={18} /> : null} />
            </List>
          </>
        )}
      </Loading>
    </Page>
  );
}

export function Coins({ nav }) {
  const st = useLoad(() => admin.payments(), []);
  const owner = nav.role === 'owner';
  const edit = async (c) => {
    const fields = [{ key: 'addr', label: `${c.symbol} address (${c.network})`, value: c.address, max: 120, hint: 'Empty = this coin is hidden in the app. A wrong address is refused.' }];
    if (c.memo_label) fields.push({ key: 'memo', label: c.memo_label, value: c.memo, max: 40, hint: 'Needed when the wallet is on an exchange.' });
    const v = await openForm({ title: c.name, submit: 'Save', fields });
    if (!v) return;
    if (v.addr.trim() !== c.address) { const r = await act('setting.set', { key: 'wallet_' + c.id, val: v.addr.trim() }, { done: v.addr.trim() ? `${c.symbol} address saved` : `${c.symbol} hidden` }); if (!r) return; }
    if (c.memo_label && v.memo.trim() !== c.memo) await act('setting.set', { key: `wallet_${c.id}_memo`, val: v.memo.trim() }, { done: `${c.memo_label} saved` });
    st.reload();
  };
  return (
    <Page title="Crypto wallets" sub="A coin without an address is hidden in the app" nav={nav}>
      <Loading st={st} rows={6}>
        {(d) => <List>{d.coins.map((c) => <Row icon="coin" title={`${c.symbol} · ${c.name}`} sub={owner ? (c.address ? c.address : 'No address') : c.network} end={<Tag tone={c.on ? 'ok' : ''}>{c.on ? 'On' : 'Off'}</Tag>} onClick={owner ? () => edit(c) : undefined} />)}</List>}
      </Loading>
    </Page>
  );
}

export function SmsLog({ p, nav }) {
  const [filter, setFilter] = useState(p.filter || 'all');
  const st = useLoad(() => admin.sms(filter === 'un' ? 'un' : ''), [filter]);
  return (
    <Page title="Bank SMS" sub="Never the SMS text, only what was read from it" nav={nav}>
      <Chips items={[{ k: 'all', label: 'All' }, { k: 'un', label: 'No order or failed' }]} value={filter} onChange={setFilter} />
      <Loading st={st} rows={5}>
        {(d) => (d.sms.length ? (
          <List>{d.sms.map((s) => <Row icon="message" title={s.toman ? `${n(s.toman)} toman` : 'No amount'} sub={`${s.sender || '?'} · ${ago(s.created_at)}${s.order_id ? ` · order #${s.order_id}` : ''}`}
            end={<Tag tone={s.result === 'paid' ? 'ok' : ['no_order', 'ambiguous', 'settle_failed'].includes(s.result) ? 'bad' : ''}>{SMS_RESULT[s.result] || s.result || '—'}</Tag>}
            onClick={s.order_id ? () => nav.push('order', { id: s.order_id }) : undefined} />)}</List>
        ) : <EmptyState icon="message" title="No SMS here" />)}
      </Loading>
    </Page>
  );
}
