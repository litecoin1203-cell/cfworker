// Provisioning on the panels (through the control plane) and all money movements.
import { first, all, run, insert, getSettingInt, getSetting } from './db.js';
import { PasarGuardError, pgOrThrow, parseExpire } from './pasarguard.js';
import { nowSec } from './util.js';
import { notifyAdmin, untrusted } from './telegram.js';
import { panelsFor, getPanel, adapterFor } from './panels.js';
import { ensureAccount, usedBytes } from './sync.js';

const GB = 1024 ** 3;
const DAY = 86400;

export class BillingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export { parseExpire };

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Create or extend the user's logical subscription and its accounts on every panel the user belongs to.
// opts.days overrides plan.duration_days and opts.dataGb overrides plan.data_limit_gb (used for trials).
// The new expiry is worked out from the control plane, not from a panel. Each panel gets the same expiry and
// limit; a panel that fails is left marked for the sync job to retry. Fails only when no panel took it.
export async function provision(env, user, plan, opts = {}) {
  if (typeof opts === 'number') opts = { days: opts };
  pgOrThrow(env); // the original panel must be configured, as before
  const days = opts.days || plan.duration_days;
  const gb = opts.dataGb != null ? opts.dataGb : plan.data_limit_gb;
  const now = nowSec();
  const dataLimit = gb ? gb * GB : 0;
  let sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);

  // time left on a running plan carries over; an expired plan starts fresh from today
  const current = sub && sub.expires_at;
  const base = current && current > now && sub.stop_reason !== 'expired' ? current : now;
  const newExpire = base + days * DAY;

  const targets = await panelsFor(env, user.id);
  if (!targets.some((p) => p.id === 1)) {
    const p1 = await getPanel(env, 1);
    if (p1 && ['active', 'rollout'].includes(p1.state)) targets.unshift(p1);
  }
  const results = []; // {panel, pa, used}
  let firstError = null;
  for (const panel of targets) {
    try {
      const pg = await adapterFor(env, panel);
      // panel 1 keeps its own device limit (HWID); newer panels leave devices to the control plane
      const hwid = panel.id === 1 ? plan.device_limit || null : null;
      let pa = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
      if (!pa && panel.id === 1 && sub && sub.pg_username) {
        // subscription from before the control plane without its panel_accounts row
        await run(env, `INSERT OR IGNORE INTO panel_accounts (user_id, panel_id, remote_username, sub_path, created_at) VALUES (?, 1, ?, ?, ?)`,
          user.id, sub.pg_username, sub.sub_url || '', now);
        pa = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = 1', user.id);
      }
      const remote = pa ? await pg.getUser(pa.remote_username) : null;
      let used = 0;
      if (remote) {
        const st = String(remote.status || '');
        used = parseInt(remote.used_traffic || 0, 10) || 0;
        if (dataLimit || st === 'limited') {
          try { await pg.resetUsage(pa.remote_username); used = 0; } catch (e) { /* not fatal: the new period starts from this reading */ }
        }
        const fields = { status: 'active', expire: newExpire, data_limit: dataLimit ? used + dataLimit : 0, data_limit_reset_strategy: 'no_reset' };
        if (hwid) fields.hwid_limit = hwid;
        const out = await pg.modifyUser(pa.remote_username, fields);
        const subPath = pg.absoluteSubUrl(out.subscription_url || '') || pa.sub_path;
        await run(env, `UPDATE panel_accounts SET sub_path = ?, desired = 'active', applied = 'active', desired_limit_bytes = ?, applied_limit_bytes = ?,
          desired_expire = ?, applied_expire = ?, dirty = 0, attempts = 0, last_error = NULL, applied_at = ? WHERE id = ?`,
          subPath, fields.data_limit, fields.data_limit, newExpire, newExpire, now, pa.id);
      } else {
        pa = await ensureAccount(env, user, panel, { expire: newExpire, limit: dataLimit, hwid });
      }
      results.push({ panel, pa: await first(env, 'SELECT * FROM panel_accounts WHERE id = ?', pa.id), used });
    } catch (e) {
      if (!(e instanceof PasarGuardError)) throw e;
      firstError = firstError || e;
      // try again from the sync job: the account (if any) must end up active with the new expiry and limit
      await run(env, `UPDATE panel_accounts SET desired = 'active', desired_limit_bytes = ?, desired_expire = ?, dirty = 1, attempts = 0
        WHERE user_id = ? AND panel_id = ?`, dataLimit, newExpire, user.id, panel.id);
    }
  }
  if (!results.length) throw firstError || new PasarGuardError('no panel is available', 0);

  // close the old period (its usage stays in the history) and open the new one
  if (sub && sub.period_id) {
    const prevUsed = await usedBytes(env, sub.period_id);
    await run(env, "UPDATE sub_periods SET ended_at = ?, end_reason = COALESCE(end_reason, 'renewed'), final_used_bytes = COALESCE(final_used_bytes, ?) WHERE id = ?",
      now, prevUsed, sub.period_id);
  }
  const periodId = await insert(env, 'sub_periods', { user_id: user.id, plan_id: plan.id, order_id: opts.orderId || null, source: opts.source || (opts.orderId ? 'order' : null), started_at: now, expires_at: newExpire, limit_bytes: dataLimit });
  for (const r of results) {
    await run(env, 'INSERT OR REPLACE INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at) VALUES (?, ?, ?, 0, ?)', periodId, r.panel.id, r.used, now);
  }
  // accounts that could not be updated now: their next reading only sets the starting point
  for (const pa of await all(env, 'SELECT panel_id FROM panel_accounts WHERE user_id = ? AND dirty = 1', user.id)) {
    await run(env, 'INSERT OR IGNORE INTO usage_counters (period_id, panel_id, baseline_pending, last_seen_at) VALUES (?, ?, 1, ?)', periodId, pa.panel_id, now);
  }

  const p1 = results.find((r) => r.panel.id === 1);
  if (!sub) {
    await insert(env, 'subscriptions', { user_id: user.id, pg_username: p1 ? p1.pa.remote_username : '' });
    sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  }
  const periodDays = Math.max(days, Math.ceil((newExpire - now) / DAY));
  await run(env,
    `UPDATE subscriptions SET plan_id = ?, expires_at = ?, data_limit_bytes = ?, device_limit = ?, period_days = ?, updated_at = ?,
       period_id = ?, state = 'active', stop_reason = NULL, used_bytes = 0, used_at = ?, baselined = 1,
       pg_username = COALESCE(?, pg_username), sub_url = COALESCE(?, sub_url) WHERE user_id = ?`,
    plan.id, newExpire, dataLimit, plan.device_limit, periodDays, now, periodId, now,
    p1 ? p1.pa.remote_username : null, p1 ? p1.pa.sub_path : null, user.id);
  return { expires: newExpire, panels: results.length };
}

// Move money in or out of a wallet atomically. One D1 batch (a single transaction) logs the movement and
// changes the balance, and only when the balance stays >= 0 and this order+reason was not applied before.
// The check and the write happen inside SQLite, so two purchases racing for the same money can no longer
// both pass the check, and a credit racing a debit is never lost.
export async function walletApply(env, user, amount, reason, orderId, note) {
  const nonce = randomHex(16);
  const [tx] = await env.DB.batch([
    // the UNIQUE(order_id, reason) index makes this idempotent per order+reason (OR IGNORE = already applied)
    env.DB.prepare(`INSERT OR IGNORE INTO wallet_tx (user_id, amount, balance_after, reason, order_id, note, created_at, nonce)
      SELECT id, ?, wallet_balance + ?, ?, ?, ?, ?, ? FROM users WHERE id = ? AND wallet_balance + ? >= 0`)
      .bind(amount, amount, reason, orderId ?? null, note || null, nowSec(), nonce, user.id, amount),
    env.DB.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ? AND EXISTS (SELECT 1 FROM wallet_tx WHERE nonce = ?)')
      .bind(amount, user.id, nonce),
  ]);
  const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
  user.wallet_balance = fresh.wallet_balance;
  user.wallet_applied = !!tx.meta.changes; // false = this order+reason was already applied (nothing moved now)
  if (!tx.meta.changes) {
    const done = orderId != null && await first(env, 'SELECT 1 FROM wallet_tx WHERE order_id = ? AND reason = ?', orderId, reason);
    if (!done) throw new BillingError('insufficient_balance', 'موجودی کیف پول کافی نیست.');
  }
  return fresh.wallet_balance;
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

// The discount code is redeemed here, before the plan is delivered, and atomically: the per-user row is
// UNIQUE(coupon_id, user_id) and the counter only moves while it is under max_uses. A second order carrying the
// same code (for example one revived after it expired) is refused instead of being delivered at the discount.
// a refunded, cancelled order gives its discount code back (only if it was never delivered)
async function releaseCoupon(env, order) {
  if (!order.coupon_id) return;
  const o = await first(env, 'SELECT provisioned_at FROM orders WHERE id = ?', order.id);
  if (o && o.provisioned_at) return;
  const r = await run(env, 'DELETE FROM coupon_uses WHERE coupon_id = ? AND user_id = ? AND order_id = ?', order.coupon_id, order.user_id, order.id);
  if (r.meta.changes) await run(env, 'UPDATE coupons SET used = used - 1 WHERE id = ? AND used > 0', order.coupon_id);
}

async function claimCoupon(env, order, user, quiet) {
  if (!order.coupon_id) return;
  const mine = await first(env, 'SELECT order_id FROM coupon_uses WHERE coupon_id = ? AND user_id = ?', order.coupon_id, order.user_id);
  if (mine && mine.order_id === order.id) return; // a retry of this same order: already counted
  const refuse = async (code, msg) => {
    if (!quiet) await notifyAdmin(env, `⚠️ سفارش #${order.id} (${user.email}) با کد تخفیفی پرداخت شده که ${msg}. تحویل نشد؛ خودت تصمیم بگیر.`);
    throw new BillingError(code, 'این کد تخفیف دیگر برای این سفارش معتبر نیست. پشتیبانی خبردار شد.');
  };
  if (mine) await refuse('coupon_used', 'این کاربر قبلاً روی سفارش دیگری استفاده کرده');
  try {
    await insert(env, 'coupon_uses', { coupon_id: order.coupon_id, user_id: order.user_id, order_id: order.id, created_at: nowSec() });
  } catch (e) {
    const now = await first(env, 'SELECT order_id FROM coupon_uses WHERE coupon_id = ? AND user_id = ?', order.coupon_id, order.user_id);
    if (now && now.order_id === order.id) return;
    await refuse('coupon_used', 'این کاربر همین الان روی سفارش دیگری استفاده کرد');
  }
  const r = await run(env, 'UPDATE coupons SET used = used + 1 WHERE id = ? AND (max_uses IS NULL OR max_uses <= 0 OR used < max_uses)', order.coupon_id);
  if (!r.meta.changes) {
    await run(env, 'DELETE FROM coupon_uses WHERE coupon_id = ? AND user_id = ? AND order_id = ?', order.coupon_id, order.user_id, order.id);
    await refuse('coupon_used_up', 'ظرفیتش پر شده');
  }
}

export const retryButton = (orderId) => ({ inline_keyboard: [[{ text: '🔁 دوباره بساز', callback_data: `rp:${orderId}` }]] });

const SETTLE_LEASE = 120; // seconds a claim holds; after that a crashed run's order can be settled again

// Mark an order paid and deliver it. Safe to call twice, also at the same time: the order is first claimed
// atomically (status 'settling'), so only one caller delivers it and the others see it paid or busy.
export async function settle(env, order, { quiet = false } = {}) {
  if (order.status === 'paid') return;
  const before = await first(env, 'SELECT status FROM orders WHERE id = ?', order.id);
  const now = nowSec();
  const claim = await run(env,
    "UPDATE orders SET status = 'settling', settling_at = ? WHERE id = ? AND status != 'paid' AND (status != 'settling' OR settling_at < ?)",
    now, order.id, now - SETTLE_LEASE);
  if (!claim.meta.changes) {
    const cur = await first(env, 'SELECT status FROM orders WHERE id = ?', order.id);
    if (cur && cur.status === 'paid') { order.status = 'paid'; return; }
    throw new BillingError('settle_busy', 'این سفارش همین الان در حال فعال‌سازی است.');
  }
  // where the order goes back to if delivery fails (a stale claim is left reviewable)
  const prev = !before || before.status === 'settling' ? 'review' : before.status;
  try {
    await deliver(env, order, quiet);
  } catch (e) {
    await run(env, "UPDATE orders SET status = ?, settling_at = NULL WHERE id = ? AND status = 'settling'", prev, order.id);
    order.status = prev;
    throw e;
  }
}

async function markPaid(env, order) {
  await run(env, "UPDATE orders SET status = 'paid', paid_at = ?, settling_at = NULL WHERE id = ?", nowSec(), order.id);
  order.status = 'paid';
}

async function deliver(env, order, quiet) {
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);
  if (order.kind === 'topup') {
    await walletApply(env, user, order.amount_toman, 'topup', order.id, `شارژ کیف پول #${order.id}`);
    await markPaid(env, order);
    if (order.activate_plan_id) await autoActivate(env, user, order);
    return;
  }
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', order.plan_id);
  if (!plan) throw new BillingError('plan_missing', 'این پلن دیگر وجود ندارد.');
  // a retry after a crash must not extend the panel account a second time
  const done = await first(env, 'SELECT provisioned_at FROM orders WHERE id = ?', order.id);
  if (!done || !done.provisioned_at) {
    await claimCoupon(env, order, user, quiet);
    try {
      await provision(env, user, plan, { orderId: order.id });
    } catch (e) {
      if (e instanceof PasarGuardError) {
        if (!quiet) {
          await notifyAdmin(env, `⚠️ ساخت اکانت روی پنل برای سفارش #${order.id} (${user.email}) انجام نشد.\n\nخطای پنل:\n${untrusted(e.message)}\n\nبعد از رفع مشکل، دکمه‌ی زیر را بزن.`, order.method === 'wallet' ? undefined : retryButton(order.id));
        }
        throw new BillingError('provision_failed', 'فعال‌سازی اشتراک الان ممکن نشد. پشتیبانی خبردار شد و به‌زودی درستش می‌کند.');
      }
      throw e;
    }
    await run(env, 'UPDATE orders SET provisioned_at = ? WHERE id = ?', nowSec(), order.id);
  }
  await referralCommission(env, user, order);
  await markPaid(env, order);
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
    await notifyAdmin(env, `⚠️ کیف پول ${user.email} شارژ شد ولی فعال‌سازی خودکار پلن انجام نشد: ${untrusted(e.message)}\nپول در کیف پول کاربر مانده است.`);
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
    await releaseCoupon(env, order);
    throw e;
  }
}
