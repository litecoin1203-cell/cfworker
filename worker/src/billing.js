// Provisioning and money movements. Ported from the Python billing service.
import { first, run, insert, getSettingInt, getSetting } from './db.js';
import { PasarGuard, PasarGuardError, pgOrThrow } from './pasarguard.js';
import { err, nowSec } from './util.js';
import { notifyAdmin } from './telegram.js';

const GB = 1024 ** 3;
const DAY = 86400;

export class BillingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function parseExpire(v) {
  if (v == null || v === 0 || v === '') return null;
  if (typeof v === 'number') return Math.floor(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

async function groupIds(env, pg) {
  const raw = (await getSetting(env, 'pg_group_ids')).trim();
  if (raw) return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  const ids = await pg.listGroupIds();
  if (!ids.length) throw new PasarGuardError('panel has no groups', 0);
  return ids;
}

// Create or extend the user's PasarGuard account. days overrides plan.duration_days (used for trials).
export async function provision(env, user, plan, days) {
  const pg = pgOrThrow(env);
  days = days || plan.duration_days;
  const now = nowSec();
  let sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  const dataLimit = plan.data_limit_gb ? plan.data_limit_gb * GB : 0;
  const hwid = plan.device_limit || null;

  let pgUser = sub ? await pg.getUser(sub.pg_username) : null;
  let newExpire;
  if (pgUser) {
    const current = parseExpire(pgUser.expire);
    const base = current && current > now ? current : now;
    newExpire = base + days * DAY;
    if (dataLimit) await pg.resetUsage(sub.pg_username);
    const fields = { status: 'active', expire: newExpire, data_limit: dataLimit, data_limit_reset_strategy: 'no_reset' };
    if (hwid) fields.hwid_limit = hwid;
    pgUser = await pg.modifyUser(sub.pg_username, fields);
  } else {
    const username = `${env.PASARGUARD_USERNAME_PREFIX || 'cg'}_${user.id}_${randomHex(2)}`;
    newExpire = now + days * DAY;
    pgUser = await pg.createUser(username, { expire: newExpire, dataLimit, groupIds: await groupIds(env, pg), hwidLimit: hwid, note: user.email });
    if (sub) await run(env, 'UPDATE subscriptions SET pg_username = ? WHERE id = ?', username, sub.id);
    else {
      await insert(env, 'subscriptions', { user_id: user.id, pg_username: username });
      sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
    }
  }
  const expires = parseExpire(pgUser.expire) || newExpire;
  const subUrl = pg.absoluteSubUrl(pgUser.subscription_url || '') || sub.sub_url;
  await run(env,
    'UPDATE subscriptions SET plan_id = ?, expires_at = ?, data_limit_bytes = ?, device_limit = ?, sub_url = ?, updated_at = ? WHERE user_id = ?',
    plan.id, expires, dataLimit, plan.device_limit, subUrl, nowSec(), user.id);
}

export async function walletApply(env, user, amount, reason, orderId, note) {
  const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
  const balance = fresh.wallet_balance + amount;
  if (balance < 0) throw new BillingError('insufficient', 'Not enough wallet balance');
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
  if (referrer) await walletApply(env, referrer, commission, 'referral', order.id, `Invite reward from order #${order.id}`);
}

// Mark an order paid and deliver it. Safe to call twice.
export async function settle(env, order) {
  if (order.status === 'paid') return;
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);
  if (order.kind === 'topup') {
    await walletApply(env, user, order.amount_toman, 'topup', order.id, `Top-up #${order.id}`);
  } else {
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', order.plan_id);
    if (!plan) throw new BillingError('plan_missing', 'Plan no longer exists');
    try {
      await provision(env, user, plan);
    } catch (e) {
      if (e instanceof PasarGuardError) {
        await notifyAdmin(env, `⚠️ Provisioning failed for order #${order.id} (${user.email}): ${e.message}`);
        throw new BillingError('provision_failed', 'Could not activate the plan right now. Support has been notified.');
      }
      throw e;
    }
    await referralCommission(env, user, order);
  }
  await run(env, "UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?", nowSec(), order.id);
  order.status = 'paid';
}

export async function payWithWallet(env, user, order) {
  const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
  if (fresh.wallet_balance < order.amount_toman) throw new BillingError('insufficient_balance', 'Your wallet balance is not enough');
  await walletApply(env, user, -order.amount_toman, 'purchase', order.id, `Payment for order #${order.id}`);
  try {
    await settle(env, order);
  } catch (e) {
    // refund what we just deducted, keeping idempotency via a distinct reason
    await walletApply(env, user, order.amount_toman, 'refund', order.id, `Refund for order #${order.id}`);
    await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
    throw e;
  }
}

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
