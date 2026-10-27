// Provisioning on the PasarGuard panel and all money movements.
import { first, run, insert, getSettingInt, getSetting } from './db.js';
import { PasarGuardError, pgOrThrow } from './pasarguard.js';
import { nowSec } from './util.js';
import { notifyAdmin } from './telegram.js';

const GB = 1024 ** 3;
const DAY = 86400;

export class BillingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function parseExpire(v) {
  if (v == null || v === 0 || v === '') return null;
  if (typeof v === 'number') return Math.floor(v);
  if (/^\d+$/.test(String(v))) return parseInt(v, 10);
  let s = String(v);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; // panel datetimes are UTC
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

async function groupIds(env, pg) {
  const raw = (await getSetting(env, 'pg_group_ids')).trim();
  if (raw) {
    const ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
    if (ids.length) return ids;
  }
  let ids;
  try { ids = await pg.listGroupIds(); }
  catch (e) {
    throw new PasarGuardError(`could not read panel groups (${e.message}). Set them by hand: /set pg_group_ids 1`, e.status || 0, e.detail);
  }
  if (!ids.length) throw new PasarGuardError('panel has no enabled groups for this admin. Create one, then /set pg_group_ids <id>', 0);
  return ids;
}

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Create or extend the user's PasarGuard account.
// opts.days overrides plan.duration_days and opts.dataGb overrides plan.data_limit_gb (used for trials).
export async function provision(env, user, plan, opts = {}) {
  if (typeof opts === 'number') opts = { days: opts };
  const pg = pgOrThrow(env);
  const days = opts.days || plan.duration_days;
  const gb = opts.dataGb != null ? opts.dataGb : plan.data_limit_gb;
  const now = nowSec();
  let sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  const dataLimit = gb ? gb * GB : 0;
  const hwid = plan.device_limit || null;

  let pgUser = sub ? await pg.getUser(sub.pg_username) : null;
  let newExpire;
  if (pgUser) {
    const current = parseExpire(pgUser.expire);
    const st = String(pgUser.status || '');
    // time left on an active plan carries over; an expired or used-up plan starts fresh from today
    const base = current && current > now && st !== 'expired' ? current : now;
    newExpire = base + days * DAY;
    if (dataLimit || st === 'limited') {
      try { await pg.resetUsage(sub.pg_username); } catch (e) { /* not fatal: the new limit still applies */ }
    }
    const fields = { status: 'active', expire: newExpire, data_limit: dataLimit, data_limit_reset_strategy: 'no_reset' };
    if (hwid) fields.hwid_limit = hwid;
    pgUser = await pg.modifyUser(sub.pg_username, fields);
  } else {
    const groups = await groupIds(env, pg);
    newExpire = now + days * DAY;
    const prefix = String(env.PASARGUARD_USERNAME_PREFIX || 'cg').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'cg';
    let username = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      username = `${prefix}_${user.id}_${randomHex(2)}`.slice(0, 32);
      try {
        pgUser = await pg.createUser(username, { expire: newExpire, dataLimit, groupIds: groups, hwidLimit: hwid, note: `Cloud Gold · ${user.email}` });
        break;
      } catch (e) {
        if (e instanceof PasarGuardError && e.status === 409 && attempt < 2) continue; // name taken, try another
        throw e;
      }
    }
    if (sub) await run(env, 'UPDATE subscriptions SET pg_username = ? WHERE id = ?', username, sub.id);
    else {
      await insert(env, 'subscriptions', { user_id: user.id, pg_username: username });
      sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
    }
  }
  const expires = parseExpire(pgUser.expire) || newExpire;
  const subUrl = pg.absoluteSubUrl(pgUser.subscription_url || '') || sub.sub_url;
  if (!subUrl) throw new PasarGuardError('panel created the user but returned no subscription link', 0);
  await run(env,
    'UPDATE subscriptions SET plan_id = ?, expires_at = ?, data_limit_bytes = ?, device_limit = ?, sub_url = ?, period_days = ?, updated_at = ? WHERE user_id = ?',
    plan.id, expires, dataLimit, plan.device_limit, subUrl, Math.max(days, Math.ceil((expires - now) / DAY)), nowSec(), user.id);
  return pgUser;
}

export async function walletApply(env, user, amount, reason, orderId, note) {
  const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
  const balance = fresh.wallet_balance + amount;
  if (balance < 0) throw new BillingError('insufficient_balance', 'موجودی کیف پول کافی نیست.');
  // the UNIQUE(order_id, reason) index makes this idempotent per order+reason
  try {
    await insert(env, 'wallet_tx', { user_id: user.id, amount, balance_after: balance, reason, order_id: orderId ?? null, note: note || null, created_at: nowSec() });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return fresh.wallet_balance; // already applied
    throw e;
  }
  await run(env, 'UPDATE users SET wallet_balance = ? WHERE id = ?', balance, user.id);
  user.wallet_balance = balance;
  return balance;
}

async function referralCommission(env, buyer, order) {
  if (!buyer.referred_by_id || order.amount_toman <= 0) return;
  const percent = await getSettingInt(env, 'referral_percent');
  if (percent <= 0) return;
  const commission = Math.floor((order.amount_toman * percent) / 100);
  if (commission <= 0) return;
  const referrer = await first(env, 'SELECT * FROM users WHERE id = ?', buyer.referred_by_id);
  if (referrer) await walletApply(env, referrer, commission, 'referral', order.id, `پاداش دعوت از سفارش #${order.id}`);
}

async function markCouponUsed(env, order) {
  if (!order.coupon_id) return;
  try {
    await insert(env, 'coupon_uses', { coupon_id: order.coupon_id, user_id: order.user_id, order_id: order.id, created_at: nowSec() });
    await run(env, 'UPDATE coupons SET used = used + 1 WHERE id = ?', order.coupon_id);
  } catch (e) { /* already counted */ }
}

export const retryButton = (orderId) => ({ inline_keyboard: [[{ text: '🔁 دوباره بساز', callback_data: `rp:${orderId}` }]] });

// Mark an order paid and deliver it. Safe to call twice.
export async function settle(env, order, { quiet = false } = {}) {
  if (order.status === 'paid') return;
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);
  if (order.kind === 'topup') {
    await walletApply(env, user, order.amount_toman, 'topup', order.id, `شارژ کیف پول #${order.id}`);
    await run(env, "UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?", nowSec(), order.id);
    order.status = 'paid';
    if (order.activate_plan_id) await autoActivate(env, user, order);
    return;
  }
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', order.plan_id);
  if (!plan) throw new BillingError('plan_missing', 'این پلن دیگر وجود ندارد.');
  try {
    await provision(env, user, plan);
  } catch (e) {
    if (e instanceof PasarGuardError) {
      if (!quiet) {
        await notifyAdmin(env, `⚠️ ساخت اکانت روی پنل برای سفارش #${order.id} (${user.email}) انجام نشد.\n\nخطای پنل:\n${e.message}\n\nبعد از رفع مشکل، دکمه‌ی زیر را بزن.`, order.method === 'wallet' ? undefined : retryButton(order.id));
      }
      throw new BillingError('provision_failed', 'فعال‌سازی اشتراک الان ممکن نشد. پشتیبانی خبردار شد و به‌زودی درستش می‌کند.');
    }
    throw e;
  }
  await referralCommission(env, user, order);
  await markCouponUsed(env, order);
  await run(env, "UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?", nowSec(), order.id);
  order.status = 'paid';
}

// A top-up that was made to buy a plan: once the money lands, buy the plan from the wallet.
async function autoActivate(env, user, topup) {
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', topup.activate_plan_id);
  if (!plan) return;
  const price = topup.activate_price_toman != null ? topup.activate_price_toman : plan.price_toman;
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  if (fresh.wallet_balance < price) {
    await notifyAdmin(env, `ℹ️ کیف پول ${user.email} شارژ شد ولی برای فعال‌سازی خودکار پلن ${plan.name} کافی نبود.`);
    return;
  }
  const id = await insert(env, 'orders', {
    user_id: user.id, kind: 'plan', plan_id: plan.id, amount_toman: price, method: 'wallet',
    coupon_id: topup.coupon_id || null, list_price_toman: plan.price_toman, created_at: nowSec(),
  });
  const order = await first(env, 'SELECT * FROM orders WHERE id = ?', id);
  try {
    await payWithWallet(env, fresh, order);
    await run(env, 'UPDATE orders SET result_order_id = ? WHERE id = ?', id, topup.id);
  } catch (e) {
    await notifyAdmin(env, `⚠️ کیف پول ${user.email} شارژ شد ولی فعال‌سازی خودکار پلن انجام نشد: ${e.message}\nپول در کیف پول کاربر مانده است.`);
  }
}

export async function payWithWallet(env, user, order) {
  const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
  if (fresh.wallet_balance < order.amount_toman) throw new BillingError('insufficient_balance', 'موجودی کیف پول کافی نیست.');
  await walletApply(env, user, -order.amount_toman, 'purchase', order.id, `پرداخت سفارش #${order.id}`);
  try {
    await settle(env, order);
  } catch (e) {
    // refund what we just deducted, keeping idempotency via a distinct reason
    await walletApply(env, user, order.amount_toman, 'refund', order.id, `بازگشت وجه سفارش #${order.id}`);
    await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
    throw e;
  }
}
