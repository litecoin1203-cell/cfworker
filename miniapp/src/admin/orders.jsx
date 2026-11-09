// Receipts and orders: the receipts waiting for a decision (photo, amount, approve / reject side by side), every
// order with filters and search, and one order with all it can still do.
import { useState, useEffect } from 'preact/hooks';
import { admin } from './api.js';
import { useLoad, Loading, act, Page } from './kit.jsx';
import { List, Row, Section, Seg, Chips, Search, Tag, Act, Button, EmptyState, KV, viewPhoto, toast } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { n, ago, day, METHOD, STATUS, STATUS_TONE } from './fmt.js';

function Thumb({ order }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url = '';
    if (order.has_receipt) admin.receipt(order.id).then((u) => { url = u; setSrc(u); }).catch(() => setFailed(true));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [order.id]);
  const label = order.method === 'coin' ? 'Crypto' : order.has_receipt ? (failed ? 'No photo' : '') : 'No photo';
  return (
    <button type="button" class="thumb" aria-label="Open the receipt photo" onClick={(e) => { e.stopPropagation(); if (src) viewPhoto(src); }}>
      {src ? <img src={src} alt="" /> : order.has_receipt && !failed ? <span class="spin" /> : <span style={{ textAlign: 'center', fontSize: '12px', padding: '6px' }}><Icon name={order.method === 'coin' ? 'coin' : 'receipt'} size={26} /><br />{label}</span>}
    </button>
  );
}

function ReceiptCard({ o, nav, after, canDecide }) {
  const what = o.plan ? `${o.plan.name}` : 'Wallet top-up';
  return (
    <div class="rc" onClick={() => nav.push('order', { id: o.id })}>
      <Thumb order={o} />
      <div class="body">
        <div class="meta"><bdi>{o.user}</bdi> · {ago(o.created_at)}</div>
        <div class="amt">{n(o.amount_toman)} <span>toman</span></div>
        <div class="meta">{what} · {METHOD[o.method] || o.method}</div>
        {o.receipt_ref || o.txid ? <div class="meta mono">{o.receipt_ref || o.txid}</div> : null}
        {canDecide ? (
          <div class="btns">
            <button type="button" class="btn primary" onClick={(e) => { e.stopPropagation(); act('order.approve', { orderId: o.id }, { confirm: `Approve order #${o.id} for ${n(o.amount_toman)} toman and activate it?`, done: `Order #${o.id} approved`, after }); }}>Approve</button>
            <button type="button" class="btn ghost" onClick={(e) => { e.stopPropagation(); act('order.reject', { orderId: o.id }, { done: `Order #${o.id} rejected`, after }); }}>Reject</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Inbox({ nav }) {
  const st = useLoad(() => admin.inbox(), []);
  useEffect(() => { if (st.data) nav.setBadge(st.data.orders.length); }, [st.data]);
  const canDecide = nav.role !== 'viewer';
  return (
    <Loading st={st} rows={3}>
      {(d) => (d.orders.length ? (
        <div class="stack">{d.orders.map((o) => <ReceiptCard o={o} nav={nav} canDecide={canDecide} after={st.reload} key={o.id} />)}</div>
      ) : <EmptyState title="No receipts waiting" text="New receipts and crypto deposits show up here." />)}
    </Loading>
  );
}

const ST = [{ k: 'all', label: 'All' }, { k: 'rev', label: 'To review' }, { k: 'pend', label: 'Awaiting payment' }, { k: 'paid', label: 'Paid' }, { k: 'rej', label: 'Rejected' }];
const MT = [{ k: '', label: 'Any method' }, { k: 'card', label: 'Card' }, { k: 'coin', label: 'Crypto' }, { k: 'wallet', label: 'Wallet' }, { k: 'crypto', label: 'Gateway' }];

export function OrderRow({ o, nav }) {
  return (
    <Row icon={o.method === 'coin' ? 'coin' : o.method === 'wallet' ? 'wallet' : 'card'} title={`${n(o.amount_toman)} toman`}
      sub={`#${o.id} · ${o.user} · ${day(o.created_at)}`} end={<Tag tone={STATUS_TONE[o.status]}>{STATUS[o.status] || o.status}</Tag>}
      onClick={() => nav.push('order', { id: o.id })} />
  );
}

function AllOrders({ nav }) {
  const [f, setF] = useState({ status: 'all', method: '', q: '' });
  const [pages, setPages] = useState([]);
  const st = useLoad(() => admin.orders(f), [f.status, f.method, f.q]);
  useEffect(() => setPages([]), [f.status, f.method, f.q]);
  const more = async () => {
    const last = pages.length ? pages[pages.length - 1] : st.data;
    try { const p = await admin.orders({ ...f, before: last.next }); setPages((x) => [...x, p]); } catch (e) { toast(e.message, { bad: true }); }
  };
  const lastPage = pages.length ? pages[pages.length - 1] : st.data;
  return (
    <>
      <Search placeholder="Order #, receipt code or txid" value={f.q} onInput={(q) => setF((x) => ({ ...x, q }))} />
      <Chips items={ST} value={f.status} onChange={(status) => setF((x) => ({ ...x, status }))} />
      <Chips items={MT} value={f.method} onChange={(method) => setF((x) => ({ ...x, method }))} />
      <Loading st={st} rows={5}>
        {(d) => (
          <>
            <p class="note" style={{ margin: '6px 0 10px' }}>{n(d.count)} orders · {n(d.total)} toman</p>
            {d.orders.length ? (
              <List>{[d, ...pages].flatMap((p) => p.orders).map((o) => <OrderRow o={o} nav={nav} />)}</List>
            ) : <EmptyState icon="search" title="No orders here" text="Try another filter." />}
            {lastPage && lastPage.more ? <div style={{ marginTop: '12px' }}><Button kind="soft" onClick={more}>Show older</Button></div> : null}
          </>
        )}
      </Loading>
    </>
  );
}

export function Receipts({ nav, p }) {
  const [tab, setTab] = useState(p.tab || 'inbox');
  return (
    <Page title="Receipts" nav={nav}>
      <Seg items={[{ k: 'inbox', label: 'To review' }, { k: 'all', label: 'All orders' }]} value={tab} onChange={setTab} />
      {tab === 'inbox' ? <Inbox nav={nav} /> : <AllOrders nav={nav} />}
    </Page>
  );
}

export function OrderDetail({ p, nav }) {
  const st = useLoad(() => admin.order(p.id), [p.id]);
  const [photo, setPhoto] = useState('');
  const write = nav.role === 'owner';
  const decide = nav.role !== 'viewer';
  return (
    <Page title={`Order #${p.id}`} nav={nav}>
      <Loading st={st} rows={4}>
        {(o) => (
          <>
            <div class="card">
              <div class="cap">{o.plan ? o.plan.name : o.kind === 'topup' ? 'Wallet top-up' : 'Top-up and plan'}</div>
              <div class="disp"><b>{n(o.amount_toman)}</b><span>toman</span><span class="of"><Tag tone={STATUS_TONE[o.status]}>{STATUS[o.status] || o.status}</Tag></span></div>
              <KV k="User"><bdi>{o.user}</bdi></KV>
              <KV k="Method">{METHOD[o.method] || o.method || '—'}</KV>
              {o.list_price_toman && o.list_price_toman !== o.amount_toman ? <KV k="List price">{n(o.list_price_toman)} toman</KV> : null}
              {o.coin_amount ? <KV k="Crypto">{o.coin_amount} {String(o.coin || '').toUpperCase()}</KV> : null}
              {o.coupon ? <KV k="Discount code">{o.coupon}</KV> : null}
              <KV k="Created">{day(o.created_at)} · {ago(o.created_at)}</KV>
              {o.paid_at ? <KV k="Paid">{day(o.paid_at)}</KV> : null}
              <KV k="Tracking code"><span class="mono">{o.receipt_ref || o.txid || '—'}</span></KV>
              {o.note ? <KV k="Note to user">{o.note}</KV> : null}
              {o.refunded ? <KV k="Refund">Returned to the wallet</KV> : null}
            </div>
            {o.has_receipt ? (
              <div style={{ marginTop: '12px' }}>
                <Button kind="ghost" onClick={async () => { try { const u = photo || await admin.receipt(o.id); setPhoto(u); viewPhoto(u); } catch (e) { toast(e.message, { bad: true }); } }}>
                  <Icon name="receipt" size={20} /> Receipt photo
                </Button>
              </div>
            ) : null}
            {decide && (o.can.approve || o.can.reject) ? (
              <div class="btns" style={{ marginTop: '12px' }}>
                {o.can.approve ? <Button onClick={() => act('order.approve', { orderId: o.id }, { confirm: `Approve order #${o.id} for ${n(o.amount_toman)} toman and activate it?`, done: 'Approved and activated', after: st.reload })}>Approve</Button> : null}
                {o.can.reject ? <Button kind="ghost" onClick={() => act('order.reject', { orderId: o.id }, { done: 'Rejected', after: st.reload })}>Reject</Button> : null}
              </div>
            ) : null}
            <Section title="More" />
            <List>
              {write && o.can.cancel ? <Row icon="close" title="Cancel order" sub="The user is told it was cancelled" onClick={() => act('order.cancel', { orderId: o.id }, { done: 'Cancelled', after: st.reload })} chevron /> : null}
              {write && o.can.refund ? <Row icon="undo" title="Refund to wallet" sub={`${n(o.amount_toman)} toman back to the user's wallet`} onClick={() => act('order.refund', { orderId: o.id }, { confirm: `Refund ${n(o.amount_toman)} toman to the user's wallet?`, done: 'Refunded to the wallet', after: st.reload })} chevron /> : null}
              {nav.role !== 'support' ? <Row icon="user" title="Open the user" sub={o.user} onClick={() => nav.push('user', { id: o.user_id })} chevron /> : null}
              {nav.role !== 'support' ? <Row icon="history" title="History" sub="Every admin change to this order" onClick={() => nav.push('audit', { type: 'order', id: String(o.id) })} chevron /> : null}
            </List>
          </>
        )}
      </Loading>
    </Page>
  );
}
