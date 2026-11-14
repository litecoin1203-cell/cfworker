// The admin bot's single write layer. Every change made from the bot, by a button, a form or an old typed
// command, goes through runAction(): it checks the input, applies the change, and writes one admin_audit row
// with what changed (before -> after). A "reversible" action also stores how to put things back, so the admin
// can undo it once, within UNDO_SECONDS, from the card or from the admin log.
//
// Risk decides how the router asks first (telegram-menu.js): reversible = no question, an undo button after;
// money = a one-time "are you sure?" (bot_confirm, 2 minutes); destructive = the same, with what it affects.
import { first, all, run, insert, getSettings, setSetting, SETTING_DEFAULTS } from './db.js';
import { hashPassword, nowSec } from './util.js';

export const UNDO_SECONDS = 600;
const fa = (n) => Number(n || 0).toLocaleString('en-US');

export const PLAN_FIELDS = { name: 'name', price: 'price_toman', old: 'old_price_toman', days: 'duration_days', gb: 'data_limit_gb', devices: 'device_limit',
  trial: 'trial_days', badge: 'badge', sort: 'sort', on: 'is_active', desc: 'description' };
const PLAN_COLS = new Set(Object.values(PLAN_FIELDS));
const TEXT_COLS = new Set(['name', 'badge', 'description']);
const MASKED = new Set(['sms_key', 'app_bridges']); // never shown in the log (bridges are working configs)
const show = (key, v) => (MASKED.has(key) && v ? '•••' : v === '' || v == null ? '(خالی)' : String(v).slice(0, 80));
const fail = (error) => ({ ok: false, error });

export const ACTIONS = {
  // ---------------- plans ----------------
  'plan.set': {
    risk: 'reversible', target: 'plan',
    async apply(env, { id, field, raw }) {
      const col = PLAN_FIELDS[String(field || '').toLowerCase()];
      if (!col) return fail('فیلد ناشناخته. فیلدها: ' + Object.keys(PLAN_FIELDS).join(' '));
      const p = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
      const val = TEXT_COLS.has(col) ? String(raw || '').trim() : parseInt(String(raw || '').replace(/[^\d]/g, '') || '0', 10);
      await run(env, `UPDATE plans SET ${col} = ? WHERE id = ?`, val, p.id);
      return { targetId: p.id, summary: `${col}: ${show(col, p[col])} → ${show(col, val)}`, undo: { id: p.id, col, value: p[col] },
        text: `✅ پلن #${p.id}: ${field} = ${val === '' ? '(خالی)' : val}` };
    },
    async undo(env, u) {
      if (!PLAN_COLS.has(u.col)) return false;
      await run(env, `UPDATE plans SET ${u.col} = ? WHERE id = ?`, u.value, u.id);
      return true;
    },
  },
  'plan.toggle': {
    risk: 'reversible', target: 'plan',
    async apply(env, { id }) {
      const p = await first(env, 'SELECT id, is_active, archived FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
      if (p.archived && !p.is_active) return fail('این پلن بایگانی است؛ اول «📤 برگرداندن از بایگانی» را بزن.');
      await run(env, 'UPDATE plans SET is_active = ? WHERE id = ?', p.is_active ? 0 : 1, p.id);
      return { targetId: p.id, summary: `is_active: ${p.is_active} → ${p.is_active ? 0 : 1}`, undo: { id: p.id, col: 'is_active', value: p.is_active },
        text: p.is_active ? '🔴 خاموش شد' : '🟢 روشن شد' };
    },
    undo: (env, u) => ACTIONS['plan.set'].undo(env, u),
  },
  'plan.create': {
    risk: 'reversible', target: 'plan',
    async apply(env, { name, days, gb, devices, price }) {
      name = String(name || '').trim();
      days = parseInt(days, 10); price = parseInt(price, 10);
      if (!name || !(days > 0) || !(price >= 0)) return fail('شکل درست: نام|روز|گیگ|دستگاه|قیمت');
      const id = await insert(env, 'plans', { name, duration_days: days, data_limit_gb: parseInt(gb, 10) || 0, device_limit: parseInt(devices, 10) || 0,
        price_toman: price, old_price_toman: 0, badge: '', description: '', trial_days: 0, is_active: 1, sort: 10 });
      return { targetId: id, summary: `${name} · ${days} روز · ${parseInt(gb, 10) || 'نامحدود'} گیگ · ${fa(price)} ت`, undo: { planId: id }, text: `✅ پلن #${id} ساخته شد.` };
    },
    // only a plan nobody bought or got yet goes away
    async undo(env, u) {
      const used = await first(env, `SELECT (SELECT COUNT(*) FROM orders WHERE plan_id = ?1 OR activate_plan_id = ?1)
        + (SELECT COUNT(*) FROM subscriptions WHERE plan_id = ?1) + (SELECT COUNT(*) FROM sub_periods WHERE plan_id = ?1) c`, u.planId);
      if (used.c) return false;
      await run(env, 'DELETE FROM plans WHERE id = ?', u.planId);
      return true;
    },
  },

  // ---------------- settings ----------------
  'setting.set': {
    risk: 'reversible', target: 'setting',
    async apply(env, { key, val }) {
      val = String(val ?? '').trim();
      if (!(key in SETTING_DEFAULTS)) return fail(`کلید ناشناخته. کلیدها:\n${Object.keys(SETTING_DEFAULTS).join('\n')}`);
      const before = (await getSettings(env))[key];
      let text = `✅ ${key} = ${MASKED.has(key) && val ? '••• (مخفی)' : val || '(خالی)'}`;
      if (key === 'card_number' && val) {
        const { luhnOk, bankOf, cardDigits } = await import('./banks.js');
        if (!luhnOk(val)) return fail('❌ این شماره کارت درست نیست (۱۶ رقم و معتبر). دوباره از روی کارت بنویس.');
        const b = bankOf(val);
        val = cardDigits(val);
        text = `✅ شماره کارت ثبت شد${b.name ? ` — بانک ${b.name}` : ''}.`;
      } else if (key.startsWith('wallet_') && val) {
        const { validAddress, validMemo, coinById } = await import('./coins.js');
        if (key.endsWith('_memo')) {
          const cid = key.slice(7, -5);
          if (!validMemo(cid, val)) return fail(cid === 'xrp' ? '❌ Destination Tag ریپل فقط عدد است (حداکثر ۱۰ رقم).' : '❌ این Memo طولانی‌تر از حد مجاز است.');
        } else if (!validAddress(key.slice(7), val)) {
          const c = coinById(key.slice(7));
          return fail(`❌ این آدرس برای ${c ? c.symbol + ' (' + c.network + ')' : key} درست به نظر نمی‌رسد. دوباره از ولتت کپی کن.\nبرای خاموش کردن این ارز: /set ${key}`);
        }
      }
      if (key === 'support_url' && val && !/^(https:\/\/|tg:\/\/)[^\s<>"']{3,300}$/i.test(val)) return fail('❌ لینک پشتیبانی باید با https:// یا tg:// شروع شود، مثلاً https://t.me/your_support');
      if (key === 'trial_data_gb' && !/^\d{1,4}$/.test(val || '0')) return fail('❌ حجم تست را به گیگ و فقط عدد بنویس (0 = مثل پلن).');
      if (key === 'announcement' && val.length > 1000) return fail('❌ اطلاعیه حداکثر ۱۰۰۰ حرف است.');
      if (key === 'app_api_bases' || key === 'app_bridges') { // a whole-list set (old /set) keeps only the items the editor would take
        const items = splitAppList(val);
        const okItems = [...new Set(items.map(key === 'app_api_bases' ? cleanBase : cleanBridge).filter(Boolean))].slice(0, LIST_MAX);
        val = okItems.join('\n');
        const dropped = items.length - okItems.length;
        text = `✅ ${KEY_LABEL[key]}: ${fa(okItems.length)} مورد ذخیره شد${dropped ? ` (${fa(dropped)} مورد نادرست یا تکراری کنار گذاشته شد)` : ''}.`;
      }
      await setSetting(env, key, val);
      return { targetId: key, summary: `${show(key, before)} → ${show(key, val)}`, undo: { key, value: before ?? '' }, text };
    },
    async undo(env, u) {
      if (!(u.key in SETTING_DEFAULTS)) return false;
      await setSetting(env, u.key, String(u.value ?? ''));
      return true;
    },
  },

  // ---------------- coupons ----------------
  'coupon.create': {
    risk: 'reversible', target: 'coupon',
    async apply(env, { code, percent, uses, days, planId }) {
      percent = parseInt(percent, 10);
      const c = String(code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!c || !(percent >= 1 && percent <= 100)) return fail('شکل درست: /coupon کد درصد [تعداد] [روز] [شماره‌پلن]\nمثال: /coupon YALDA 20 100 7');
      uses = parseInt(uses, 10) || 0; days = parseInt(days, 10) || 0; planId = parseInt(planId, 10) || null;
      try {
        await insert(env, 'coupons', { code: c, percent, max_uses: uses, expires_at: days > 0 ? nowSec() + days * 86400 : null, plan_id: planId, is_active: 1, created_at: nowSec() });
      } catch (e) { return fail('این کد قبلاً ساخته شده. اول /delcoupon ' + c); }
      return { targetId: c, summary: `${percent}%${uses ? ` · ${uses} بار` : ''}${days ? ` · ${days} روز` : ''}${planId ? ` · پلن #${planId}` : ''}`, undo: { code: c },
        text: `🏷 کد ${c} ساخته شد: ${percent}% تخفیف${uses ? `، ${uses} بار` : ''}${days ? `، ${days} روز` : ''}${planId ? `، فقط پلن #${planId}` : ''}` };
    },
    async undo(env, u) {
      const r = await run(env, 'DELETE FROM coupons WHERE code = ? AND used = 0', u.code);
      return !!(r.meta && r.meta.changes);
    },
  },
  'coupon.delete': {
    risk: 'destructive', target: 'coupon',
    async apply(env, { code }) {
      code = String(code || '').toUpperCase();
      const r = await run(env, 'DELETE FROM coupons WHERE code = ?', code);
      const deleted = !!(r.meta && r.meta.changes);
      return { targetId: code, deleted, skipAudit: !deleted, summary: null, text: deleted ? `کد ${code} پاک شد.` : 'این کد پیدا نشد.' };
    },
  },

  // ---------------- panels ----------------
  'panel.rollout': {
    risk: 'reversible', target: 'panel',
    async apply(env, { panelId, pct }) {
      const { getPanel, setRollout } = await import('./panels.js');
      const panel = await getPanel(env, parseInt(panelId, 10));
      if (!panel) return fail('پنل پیدا نشد.');
      pct = parseInt(pct, 10);
      if (!(pct >= 0 && pct <= 100)) return fail('شکل درست: /rollout شماره درصد (0 تا 100)');
      if (!['testing', 'rollout', 'active'].includes(panel.state)) return fail('اول پنل را تست کن: /paneltest ' + panel.id);
      const p = await setRollout(env, panel, pct);
      return { targetId: panel.id, panel: p, summary: `${pct}%`, undo: { panelId: panel.id, state: panel.state, pct: panel.rollout_percent } };
    },
    async undo(env, u) {
      if (!['testing', 'rollout', 'active'].includes(u.state)) return false;
      const r = await run(env, "UPDATE panels SET state = ?, rollout_percent = ? WHERE id = ? AND state IN ('testing', 'rollout', 'active')", u.state, u.pct || 0, u.panelId);
      return !!(r.meta && r.meta.changes);
    },
  },
  'panel.groups': {
    risk: 'reversible', target: 'panel',
    async apply(env, { panelId, ids }) {
      const { getPanel, options } = await import('./panels.js');
      const panel = await getPanel(env, parseInt(panelId, 10));
      if (!panel) return fail('پنل پیدا نشد.');
      ids = (ids || []).map((x) => parseInt(x, 10)).filter((n) => n > 0);
      await run(env, 'UPDATE panels SET options_json = ? WHERE id = ?', JSON.stringify({ ...options(panel), group_ids: ids }), panel.id);
      return { targetId: panel.id, summary: ids.join(',') || 'همه', undo: { panelId: panel.id, options_json: panel.options_json ?? null },
        text: `✅ گروه‌های پنل #${panel.id}: ${ids.join(',') || 'همه‌ی گروه‌های مجاز'}` };
    },
    async undo(env, u) {
      await run(env, 'UPDATE panels SET options_json = ? WHERE id = ?', u.options_json, u.panelId);
      return true;
    },
  },
  'panel.drain': {
    risk: 'destructive', target: 'panel',
    async apply(env, { panelId }) {
      const { getPanel, drainPanel } = await import('./panels.js');
      const panel = await getPanel(env, parseInt(panelId, 10));
      if (!panel) return fail('پنل پیدا نشد');
      await drainPanel(env, panel);
      return { targetId: panel.id, summary: `خارج‌سازی ${panel.label}`,
        text: `پنل #${panel.id} (${panel.label}) از لیست خارج شد. مصرفش یک بار دیگر خوانده می‌شود، بعد اکانت‌هایش خاموش و پنل غیرفعال می‌شود. تاریخچه‌ی مصرف پاک نمی‌شود.` };
    },
  },

  // ---------------- users ----------------
  // throws the panel's error when the account cannot be made; the caller shows it
  'user.grant': {
    risk: 'money', target: 'user',
    async apply(env, { userId, planId }) {
      const u = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(userId, 10));
      const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(planId, 10));
      if (!u || !plan) return fail('کاربر یا پلن پیدا نشد');
      const { provision } = await import('./billing.js');
      await provision(env, u, plan, { source: 'gift' });
      return { targetId: u.id, summary: `پلن #${plan.id}`, user: u, plan, text: `پلن ${plan.name} به ${u.email} داده شد.` };
    },
  },
  'user.link': {
    risk: 'money', target: 'user',
    async apply(env, { userId, panelId, username, planId }) {
      const u = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(userId, 10));
      const { getPanel } = await import('./panels.js');
      const panel = await getPanel(env, parseInt(panelId, 10));
      const { linkCheck } = await import('./telegram.js');
      const check = u && panel ? await linkCheck(env, u, panel, username) : { error: 'کاربر یا پنل پیدا نشد' };
      if (check.error) return fail('❌ ' + check.error);
      // still held by a user deleted before deletes let go of their accounts: that row is dead, free it
      if (check.staleId) await run(env, 'DELETE FROM panel_accounts WHERE id = ? AND user_id = ?', check.staleId, check.staleUser);
      const { linkAccount } = await import('./sync.js');
      planId = parseInt(planId, 10) || null;
      const plan = planId ? await first(env, 'SELECT id, name FROM plans WHERE id = ?', planId) : null;
      let r;
      try { r = await linkAccount(env, u, panel, check.remote, { planId: plan ? plan.id : null }); } catch (e) {
        return fail('⚠️ وصل نشد:\n' + (/UNIQUE/i.test(String(e && e.message)) ? 'این اکانت پنل همین الان به کاربر دیگری وصل شد.' : (e && e.message) || 'خطای ناشناخته'));
      }
      let text = `اکانت ${username} از پنل #${panel.id} به ${u.email} وصل شد${plan ? ` (پلن ${plan.name})` : ''}. روی پنل چیزی ساخته نشد؛ همان لینک و همان کانفیگ‌ها در اپ می‌آید.`;
      if (r.merged) text += '\nمصرف این اکانت به مصرف اشتراک فعلی اضافه شد و سقف و زمانش با همان اشتراک یکی شد.';
      if (r.replaced) text += r.disabled ? `\nاکانت قبلی‌اش (${r.replaced}) روی پنل خاموش شد.` : `\n⚠️ اکانت قبلی‌اش (${r.replaced}) خاموش نشد؛ آن را در پنل دستی خاموش کن.`;
      return { targetId: u.id, text,
        summary: `پنل #${panel.id} ← ${username}${r.merged ? ' (جمع با اشتراک فعلی)' : ''}${plan ? ` · پلن #${plan.id}` : ''}${r.replaced ? ` (به جای ${r.replaced})` : ''}` };
    },
  },
  'user.reset_password': {
    risk: 'money', target: 'user',
    async apply(env, { email, pass }) {
      if (!email || !pass || String(pass).length < 8) return fail('شکل درست: /reset email@example.com رمزجدید (حداقل ۸ کاراکتر)');
      const u = await first(env, 'SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
      if (!u) return fail('کاربری با این ایمیل نیست.');
      await run(env, 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashPassword(pass, env.SECRET_KEY), u.id);
      return { targetId: u.id, summary: null, text: `رمز ${email} عوض شد. گوشی‌های دیگر از حساب خارج شدند.` };
    },
  },
};

// ---------------- users (stage 2): subscription, wallet, devices, security ----------------
// Every subscription change is written to the control plane (subscriptions, the current period, each panel
// account's desired_* with dirty = 1) and then pushed by the same evaluate()/pushPending() path the grant and the
// sync job use, so every panel follows and none is written to directly. A forced recompute (applied_limit = -1)
// makes evaluate() rewrite each panel's limit even when the change is smaller than its tolerance.
const GB = 1024 ** 3;
const DAY = 86400;
export const DELETED_EMAIL = (id) => `deleted+${id}@invalid`;
export const isDeleted = (u) => /^deleted\+\d+@invalid$/.test(String(u && u.email));

const userRow = (env, userId) => first(env, 'SELECT * FROM users WHERE id = ?', parseInt(userId, 10));
const subRow = (env, userId) => first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', parseInt(userId, 10));
async function settle(env, userId) {
  const { evaluate, pushPending } = await import('./sync.js');
  await evaluate(env, userId);
  await pushPending(env, { userId });
}
const st = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
// stopped accounts come back only for a user who is not blocked
const reviveAccounts = (env, userId) => st(env, `UPDATE panel_accounts SET desired = 'active', applied_limit_bytes = -1, dirty = 1, attempts = 0
  WHERE user_id = ? AND desired = 'stopped' AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_active = 1)`, userId, userId);
const stopAccounts = (env, userId) => st(env, "UPDATE panel_accounts SET desired = 'stopped', dirty = 1, attempts = 0 WHERE user_id = ? AND desired = 'active'", userId);
const forceLimits = (env, userId) => st(env, "UPDATE panel_accounts SET applied_limit_bytes = -1 WHERE user_id = ? AND desired = 'active'", userId);
// a period that was closed by expiry or quota is opened again when the reason goes away
const reopen = (env, sub) => [
  st(env, "UPDATE subscriptions SET state = 'active', stop_reason = NULL WHERE id = ?", sub.id),
  st(env, 'UPDATE sub_periods SET ended_at = NULL, end_reason = NULL, final_used_bytes = NULL WHERE id = ?', sub.period_id),
  reviveAccounts(env, sub.user_id),
];
const needSub = (sub) => (!sub || !sub.period_id ? fail('این کاربر اشتراک ندارد. اول از «🎁 دادن پلن» برایش پلن بگذار.') : null);
const ymd = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : 'نامحدود');
const isOn = (v) => v === true || v === '1' || v === 1;

Object.assign(ACTIONS, {
  'user.add_days': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, days }) {
      days = parseInt(days, 10);
      if (!(days >= 1 && days <= 3650)) return fail('تعداد روز باید بین 1 و 3650 باشد.');
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      if (!sub.expires_at) return fail('زمان این اشتراک نامحدود است.');
      const exp = Math.max(sub.expires_at, nowSec()) + days * DAY;
      const stmts = [
        st(env, 'UPDATE subscriptions SET expires_at = ?, period_days = COALESCE(period_days, 0) + ? WHERE id = ?', exp, days, sub.id),
        st(env, 'UPDATE sub_periods SET expires_at = ? WHERE id = ?', exp, sub.period_id),
        st(env, "UPDATE panel_accounts SET desired_expire = ?, dirty = 1, attempts = 0 WHERE user_id = ? AND desired IN ('active', 'stopped')", exp, sub.user_id),
      ];
      if (sub.state === 'stopped' && sub.stop_reason === 'expired') stmts.push(...reopen(env, sub));
      await env.DB.batch(stmts);
      await settle(env, sub.user_id);
      return { targetId: sub.user_id, summary: `+${days} روز · انقضا ${ymd(sub.expires_at)} → ${ymd(exp)}`,
        undo: { userId: sub.user_id, expires: sub.expires_at, days }, text: `✅ ${days} روز اضافه شد (تا ${ymd(exp)}).` };
    },
    async undo(env, u) {
      const sub = await subRow(env, u.userId);
      if (!sub || !sub.period_id) return false;
      await env.DB.batch([
        st(env, 'UPDATE subscriptions SET expires_at = ?, period_days = MAX(0, COALESCE(period_days, 0) - ?) WHERE id = ?', u.expires, u.days, sub.id),
        st(env, 'UPDATE sub_periods SET expires_at = ? WHERE id = ?', u.expires, sub.period_id),
        st(env, "UPDATE panel_accounts SET desired_expire = ?, dirty = 1, attempts = 0 WHERE user_id = ? AND desired IN ('active', 'stopped')", u.expires, sub.user_id),
      ]);
      await settle(env, sub.user_id); // stops it again if that time has already passed
      return true;
    },
  },
  'user.add_gb': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, gb }) {
      gb = parseInt(gb, 10);
      if (!(gb >= 1 && gb <= 100000)) return fail('حجم باید بین 1 و 100000 گیگ باشد.');
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      if (!sub.data_limit_bytes) return fail('حجم این اشتراک نامحدود است.');
      const limit = sub.data_limit_bytes + gb * GB;
      const stmts = [
        st(env, 'UPDATE subscriptions SET data_limit_bytes = ? WHERE id = ?', limit, sub.id),
        st(env, 'UPDATE sub_periods SET limit_bytes = ? WHERE id = ?', limit, sub.period_id),
        forceLimits(env, sub.user_id),
      ];
      if (sub.state === 'stopped' && sub.stop_reason === 'quota' && sub.used_bytes < limit) stmts.push(...reopen(env, sub));
      await env.DB.batch(stmts);
      await settle(env, sub.user_id);
      return { targetId: sub.user_id, summary: `+${gb} گیگ · سقف ${(sub.data_limit_bytes / GB).toFixed(1)} → ${(limit / GB).toFixed(1)}`,
        undo: { userId: sub.user_id, limit: sub.data_limit_bytes }, text: `✅ ${gb} گیگ اضافه شد.` };
    },
    async undo(env, u) {
      const sub = await subRow(env, u.userId);
      if (!sub || !sub.period_id) return false;
      await env.DB.batch([
        st(env, 'UPDATE subscriptions SET data_limit_bytes = ? WHERE id = ?', u.limit, sub.id),
        st(env, 'UPDATE sub_periods SET limit_bytes = ? WHERE id = ?', u.limit, sub.period_id),
        forceLimits(env, sub.user_id),
      ]);
      await settle(env, sub.user_id); // stops on quota if the old limit is already used
      return true;
    },
  },
  // usage of the current period goes back to zero; each counter keeps its last panel reading as the new start
  'user.reset_usage': {
    risk: 'money', target: 'user',
    async apply(env, { userId }) {
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      const stmts = [
        st(env, 'UPDATE usage_counters SET accounted_bytes = 0 WHERE period_id = ?', sub.period_id),
        st(env, 'UPDATE subscriptions SET used_bytes = 0, used_at = ? WHERE id = ?', nowSec(), sub.id),
        forceLimits(env, sub.user_id),
      ];
      if (sub.state === 'stopped' && sub.stop_reason === 'quota') stmts.push(...reopen(env, sub));
      await env.DB.batch(stmts);
      await settle(env, sub.user_id);
      return { targetId: sub.user_id, summary: `مصرف ${(sub.used_bytes / GB).toFixed(2)} گیگ → 0`, text: '✅ مصرف این دوره صفر شد؛ همه‌ی پنل‌ها دوباره سقف کامل را می‌گیرند.' };
    },
  },
  'user.pause': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, on }) {
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      const pause = isOn(on);
      if (pause) {
        if (sub.state !== 'active') return fail('این اشتراک همین الان فعال نیست.');
        await env.DB.batch([st(env, "UPDATE subscriptions SET state = 'stopped', stop_reason = 'admin' WHERE id = ? AND state = 'active'", sub.id), stopAccounts(env, sub.user_id)]);
      } else {
        if (!(sub.state === 'stopped' && sub.stop_reason === 'admin')) return fail('این اشتراک قطع موقت نیست.');
        await env.DB.batch([st(env, "UPDATE subscriptions SET state = 'active', stop_reason = NULL WHERE id = ?", sub.id), reviveAccounts(env, sub.user_id)]);
      }
      await settle(env, sub.user_id);
      return { targetId: sub.user_id, summary: pause ? 'قطع موقت' : 'وصل دوباره', undo: { userId: sub.user_id, on: pause ? 0 : 1 },
        text: pause ? '⏸ اشتراک قطع موقت شد؛ همه‌ی پنل‌ها خاموش می‌شوند.' : '▶️ اشتراک دوباره وصل شد.' };
    },
    async undo(env, u) {
      const r = await ACTIONS['user.pause'].apply(env, { userId: u.userId, on: u.on });
      return r.ok !== false;
    },
  },
  'user.end': {
    risk: 'destructive', target: 'user',
    async apply(env, { userId }) {
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      const now = nowSec();
      await env.DB.batch([
        st(env, "UPDATE subscriptions SET expires_at = ?, state = 'active', stop_reason = NULL WHERE id = ?", now, sub.id),
        st(env, 'UPDATE sub_periods SET expires_at = ? WHERE id = ?', now, sub.period_id),
        st(env, "UPDATE panel_accounts SET desired_expire = ? WHERE user_id = ? AND desired IN ('active', 'stopped')", now, sub.user_id),
      ]);
      await settle(env, sub.user_id); // stops it as expired: period closed, every panel switched off
      return { targetId: sub.user_id, summary: `پایان اشتراک (انقضای قبلی ${ymd(sub.expires_at)})`, text: '⏹ اشتراک تمام شد و همه‌ی پنل‌ها خاموش می‌شوند.' };
    },
  },
  'user.plan_name': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, planId }) {
      const sub = await subRow(env, userId);
      const no = needSub(sub); if (no) return no;
      planId = parseInt(planId, 10) || null;
      const plan = planId ? await first(env, 'SELECT id, name FROM plans WHERE id = ?', planId) : null;
      if (planId && !plan) return fail('پلن پیدا نشد.');
      await env.DB.batch([st(env, 'UPDATE subscriptions SET plan_id = ? WHERE id = ?', planId, sub.id), st(env, 'UPDATE sub_periods SET plan_id = ? WHERE id = ?', planId, sub.period_id)]);
      return { targetId: sub.user_id, summary: `پلن #${sub.plan_id || '-'} → #${planId || '-'}`, undo: { userId: sub.user_id, planId: sub.plan_id || 0 },
        text: plan ? `✅ پلن در اپ: ${plan.name} (حجم و زمان عوض نشد)` : '✅ پلن از اشتراک برداشته شد (حجم و زمان عوض نشد)' };
    },
    async undo(env, u) {
      const r = await ACTIONS['user.plan_name'].apply(env, { userId: u.userId, planId: u.planId });
      return r.ok !== false;
    },
  },
  // admin_credit / admin_debit through walletApply (one atomic batch; never below zero)
  'user.wallet': {
    risk: 'money', target: 'user',
    async apply(env, { userId, amount, note }) {
      amount = parseInt(amount, 10);
      note = String(note || '').trim().slice(0, 200);
      if (!amount || Math.abs(amount) > 1e10) return fail('مبلغ درست نیست.');
      if (!note) return fail('دلیل (یادداشت) لازم است.');
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      const before = u.wallet_balance;
      const { walletApply, BillingError } = await import('./billing.js');
      let after;
      try { after = await walletApply(env, u, amount, amount > 0 ? 'admin_credit' : 'admin_debit', null, note); } catch (e) {
        if (e instanceof BillingError) return fail(`❌ موجودی کافی نیست (موجودی: ${fa(before)} تومان). کیف پول هیچ‌وقت منفی نمی‌شود.`);
        throw e;
      }
      return { targetId: u.id, summary: `${amount > 0 ? '+' : ''}${fa(amount)} ت · ${fa(before)} → ${fa(after)} · ${note}`,
        text: `${amount > 0 ? '➕ شارژ' : '➖ کسر'} ${fa(Math.abs(amount))} تومان انجام شد. موجودی: ${fa(after)} تومان.` };
    },
  },
  'user.device_remove': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, deviceId }) {
      const u = await userRow(env, userId);
      const dev = await first(env, 'SELECT * FROM devices WHERE id = ? AND user_id = ?', parseInt(deviceId, 10), parseInt(userId, 10));
      if (!u || !dev) return fail('این دستگاه پیدا نشد.');
      const { removeDevice } = await import('./account.js');
      await removeDevice(env, u, dev.id);
      return { targetId: u.id, summary: `حذف دستگاه ${String(dev.model || dev.device_id).slice(0, 30)}`, text: '🗑 دستگاه حذف شد.' };
    },
  },
  'user.logout_all': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId }) {
      const r = await run(env, 'UPDATE users SET token_version = token_version + 1 WHERE id = ?', parseInt(userId, 10));
      if (!r.meta.changes) return fail('کاربر پیدا نشد.');
      return { targetId: parseInt(userId, 10), summary: 'خروج از همه‌ی دستگاه‌ها', text: '🚪 از همه‌ی دستگاه‌ها خارج شد؛ باید دوباره وارد شود.' };
    },
  },
  // blocked = no login, no refresh, and every panel account switched off (through the ledger)
  'user.block': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, on }) {
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      if (isDeleted(u)) return fail('این کاربر حذف شده است.');
      const block = isOn(on);
      if (block) {
        if (!u.is_active) return fail('همین الان مسدود است.');
        await env.DB.batch([st(env, 'UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?', u.id), stopAccounts(env, u.id)]);
      } else {
        if (u.is_active) return fail('مسدود نیست.');
        const sub = await subRow(env, u.id);
        const stmts = [st(env, 'UPDATE users SET is_active = 1 WHERE id = ?', u.id)];
        if (sub && sub.state === 'active') stmts.push(reviveAccounts(env, u.id));
        await env.DB.batch(stmts);
      }
      await settle(env, u.id);
      return { targetId: u.id, summary: block ? 'مسدود' : 'آزاد', undo: { userId: u.id, on: block ? 0 : 1 },
        text: block ? '⛔️ مسدود شد: نمی‌تواند وارد شود و همه‌ی پنل‌هایش خاموش می‌شوند.' : '✅ آزاد شد.' };
    },
    async undo(env, u) {
      const r = await ACTIONS['user.block'].apply(env, { userId: u.userId, on: u.on });
      return r.ok !== false;
    },
  },
  'user.unlink_tg': {
    risk: 'destructive', target: 'user',
    async apply(env, { userId }) {
      const u = await userRow(env, userId);
      if (!u || !u.tg_id) return fail('این کاربر تلگرام وصل‌شده ندارد.');
      await run(env, "UPDATE users SET tg_id = NULL, tg_username = NULL, tg_name = '' WHERE id = ?", u.id);
      return { targetId: u.id, summary: `جداکردن تلگرام ${u.tg_username ? '@' + u.tg_username : u.tg_id}`, text: '📨 تلگرام از این حساب جدا شد.' };
    },
  },
  'user.avatar_reset': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId }) {
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      if (!u.avatar) return fail('این کاربر آواتار انتخاب نکرده است.');
      await run(env, 'UPDATE users SET avatar = NULL WHERE id = ?', u.id);
      return { targetId: u.id, summary: `آواتار ${u.avatar} → پاک شد (کاربر باید دوباره انتخاب کند)`, undo: { userId: u.id, avatar: u.avatar }, text: '🖼 آواتار برگردانده شد.' };
    },
    async undo(env, u) {
      await run(env, 'UPDATE users SET avatar = ? WHERE id = ? AND avatar IS NULL', u.avatar, u.userId);
      return true;
    },
  },
  'user.email': {
    risk: 'reversible', target: 'user',
    async apply(env, { userId, email }) {
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      if (isDeleted(u)) return fail('این کاربر حذف شده است.');
      const e = await checkEmail(env, email);
      if (e.error) return fail(e.error);
      try { await run(env, 'UPDATE users SET email = ? WHERE id = ?', e.email, u.id); } catch (x) { return fail('این ایمیل همین الان برای حساب دیگری ثبت شد.'); }
      return { targetId: u.id, summary: `${u.email} → ${e.email}`, undo: { userId: u.id, email: u.email }, text: `✅ ایمیل شد ${e.email}` };
    },
    async undo(env, u) {
      if (await first(env, 'SELECT 1 x FROM users WHERE email = ?', u.email)) return false;
      await run(env, 'UPDATE users SET email = ? WHERE id = ?', u.email, u.userId);
      return true;
    },
  },
  // soft delete: panels off, email and Telegram freed, sessions ended; orders and wallet history stay
  'user.delete': {
    risk: 'destructive', target: 'user',
    async apply(env, { userId }) {
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      if (isDeleted(u)) return fail('این کاربر قبلاً حذف شده است.');
      await env.DB.batch([
        st(env, `UPDATE users SET email = ?, tg_id = NULL, tg_username = NULL, tg_name = '', avatar = NULL, is_active = 0,
          token_version = token_version + 1 WHERE id = ?`, DELETED_EMAIL(u.id), u.id),
        st(env, "UPDATE subscriptions SET state = 'stopped', stop_reason = 'admin' WHERE user_id = ?", u.id),
        st(env, "UPDATE sub_periods SET ended_at = ?, end_reason = 'admin' WHERE user_id = ? AND ended_at IS NULL", nowSec(), u.id),
        st(env, "UPDATE panel_accounts SET desired = 'removed', dirty = 1, attempts = 0 WHERE user_id = ? AND desired != 'removed'", u.id),
        st(env, "UPDATE subscriptions SET pg_username = '', sub_url = '' WHERE user_id = ?", u.id),
        st(env, 'DELETE FROM devices WHERE user_id = ?', u.id),
      ]);
      // switch every account off on its panel, then let go of all of them: a panel account is never kept by a
      // deleted user, so the admin can link it to another app account later (switched off, never deleted)
      const { pushPending } = await import('./sync.js');
      await pushPending(env, { userId: u.id });
      const accts = await all(env, 'SELECT panel_id, remote_username, dirty FROM panel_accounts WHERE user_id = ? ORDER BY panel_id', u.id);
      if (accts.length) await run(env, 'DELETE FROM panel_accounts WHERE user_id = ?', u.id);
      const stuck = accts.filter((a) => a.dirty);
      const lines = [`🗑 کاربر حذف شد. سفارش‌ها و تاریخچه‌ی کیف پولش (موجودی ${fa(u.wallet_balance)} تومان) برای حساب‌رسی می‌ماند.`];
      if (accts.length) lines.push(`🔓 ${fa(accts.length)} اکانت پنلش (${accts.map((a) => `${a.remote_username} روی #${a.panel_id}`).join('، ')}) از این کاربر جدا شد و آزاد است؛ می‌توانی هر کدام را به کاربر دیگری وصل کنی.`);
      if (stuck.length) lines.push(`⚠️ این‌ها روی پنل خاموش نشدند (پنل جواب نداد)؛ دستی خاموششان کن: ${stuck.map((a) => `${a.remote_username} روی #${a.panel_id}`).join('، ')}`);
      return { targetId: u.id, summary: `حذف ${u.email}${u.tg_username ? ' @' + u.tg_username : ''}${accts.length ? ` · آزاد: ${accts.map((a) => `#${a.panel_id} ${a.remote_username}`).join(', ')}` : ''}`,
        text: lines.join('\n') };
    },
  },
  // One panel account stops being this user's: the link row goes, so the same panel account can be linked to
  // another app user. off = also switch it off on the panel (never deleted there). Usage it already brought into
  // the current period stays counted.
  'user.unlink_panel': {
    risk: 'destructive', target: 'user',
    async apply(env, { userId, panelId, off }) {
      const u = await userRow(env, userId);
      if (!u) return fail('کاربر پیدا نشد.');
      const pa = await first(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json FROM panel_accounts a
        JOIN panels p ON p.id = a.panel_id WHERE a.user_id = ? AND a.panel_id = ?`, u.id, parseInt(panelId, 10));
      if (!pa) return fail('این کاربر روی این پنل اکانت وصل‌شده ندارد.');
      off = isOn(off);
      let note = 'روی پنل دست نخورد و همان‌طور که بود ماند.';
      if (off) {
        try {
          const { adapterFor } = await import('./panels.js');
          const pg = await adapterFor(env, { id: pa.panel_id, kind: pa.kind, state: pa.panel_state, cred_ref: pa.cred_ref, options_json: pa.options_json });
          await pg.setStatus(pa.remote_username, 'disabled');
          note = 'روی پنل خاموش شد (پاک نشد).';
        } catch (e) { note = '⚠️ روی پنل خاموش نشد (پنل جواب نداد)؛ اگر لازم است دستی خاموشش کن.'; }
      }
      // removed only if it is still the same account (a link made meanwhile is left alone)
      const res = await env.DB.batch([
        st(env, 'DELETE FROM panel_accounts WHERE id = ? AND remote_username = ?', pa.id, pa.remote_username),
        // the old panel-1 fields would otherwise bring this account back as the user's (billing.provision)
        st(env, "UPDATE subscriptions SET pg_username = '', sub_url = '' WHERE user_id = ? AND ? = 1 AND pg_username = ?", u.id, pa.panel_id, pa.remote_username),
      ]);
      if (!Number((res[0].meta && res[0].meta.changes) || 0)) return fail('این اکانت همین الان عوض شد؛ صفحه را دوباره باز کن.');
      const sub = await subRow(env, u.id);
      const live = u.is_active && !isDeleted(u) && sub && sub.state === 'active' && sub.period_id && (!sub.expires_at || sub.expires_at > nowSec());
      const lines = [`✂️ اکانت ${pa.remote_username} (پنل #${pa.panel_id}) از ${u.email} جدا شد. ${note}`,
        'حالا می‌توانی همین اکانت را به کاربر دیگری وصل کنی.'];
      if (live) lines.push('ℹ️ اشتراک این کاربر هنوز فعال است، پس اپ برایش یک اکانت تازه روی پنل‌هایش می‌سازد. اگر نمی‌خواهی، «⏹ پایان اشتراک» را بزن.');
      return { targetId: u.id, summary: `جداکردن ${pa.remote_username} از پنل #${pa.panel_id}${off ? ' + خاموش' : ''}`, text: lines.join('\n') };
    },
  },
  // the password reaches here already hashed (the form hashes it the moment it is typed)
  'user.create': {
    risk: 'reversible', target: 'user',
    async apply(env, { email, hash }) {
      const e = await checkEmail(env, email);
      if (e.error) return fail(e.error);
      if (!/^pbkdf2\$/.test(String(hash || ''))) return fail('رمز درست نیست.');
      const { newUserFields } = await import('./auth.js');
      let id;
      try { id = await insert(env, 'users', { email: e.email, password_hash: hash, ...(await newUserFields(env, {})) }); } catch (x) { return fail('این ایمیل همین الان ثبت شد.'); }
      return { targetId: id, summary: `کاربر دستی ${e.email}`, text: `✅ کاربر ${e.email} ساخته شد. حالا می‌توانی برایش پلن بگذاری.` };
    },
  },
});

// ---------------- sales (stage 3): orders, plans, coupons ----------------
// Money moves only through settle() (approve) and walletApply() (refund), the same paths the app and the
// payment checkers use, so a double tap or two admins at once can never deliver or refund twice.
const orderRow = (env, id) => first(env, 'SELECT * FROM orders WHERE id = ?', parseInt(id, 10));
const ORDER_OPEN = ['pending', 'review', 'expired', 'rejected'];
// an order put back after a reject/cancel must not take a transfer another order holds now
const TXID_FREE = `(txid IS NULL OR NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.txid = orders.txid AND o2.id != orders.id
  AND o2.status NOT IN ('rejected', 'cancelled')))`;
export const REJECT_NOTE = (o) => (o.method === 'coin' ? 'واریز ارز دیجیتال پیدا نشد. اگر واریز کرده‌ای، هش تراکنش را دوباره بفرست یا با پشتیبانی تماس بگیر.'
  : 'رسید تأیید نشد. اگر واریز کرده‌ای با پشتیبانی تماس بگیر.');
// a plan someone bought, got, or a code points at stays (archived) so history keeps its name
export const planUses = async (env, id) => (await first(env, `SELECT (SELECT COUNT(*) FROM orders WHERE plan_id = ?1 OR activate_plan_id = ?1)
  + (SELECT COUNT(*) FROM subscriptions WHERE plan_id = ?1) + (SELECT COUNT(*) FROM sub_periods WHERE plan_id = ?1)
  + (SELECT COUNT(*) FROM coupons WHERE plan_id = ?1) c`, id)).c;
export const COUPON_FIELDS = { p: 'percent', u: 'max_uses', d: 'expires_at', l: 'plan_id' };

Object.assign(ACTIONS, {
  'order.approve': {
    risk: 'money', target: 'order',
    async apply(env, { orderId }) {
      const o = await orderRow(env, orderId);
      if (!o) return fail('سفارش پیدا نشد.');
      if (o.status === 'paid') return fail('این سفارش قبلاً تأیید و فعال شده است.');
      const { settle, BillingError, isStuck, recoverStuck } = await import('./billing.js');
      // «🔁 تلاش دوباره» on an order whose settle was cut off (PAY-01): settle once more, never twice
      if (isStuck(o)) {
        let r;
        try { r = await recoverStuck(env, o); } catch (e) { return fail('⚠️ ' + (e instanceof BillingError ? e.message : (e && e.message) || 'خطای ناشناخته')); }
        const why = r.error ? `\nخطا: ${(r.error instanceof BillingError ? r.error.message : r.error.message) || ''}` : '';
        if (r.result === 'paid') return { targetId: o.id, summary: `تلاش دوباره · ${fa(o.amount_toman)} ت · ${o.method}`, text: `✅ سفارش #${o.id} دوباره امتحان شد و تحویل شد.` };
        if (r.result === 'refunded') return fail(`↩️ سفارش #${o.id} دوباره هم تحویل نشد؛ مبلغش به کیف پول کاربر برگشت و سفارش لغو شد.${why}`);
        return fail(`⚠️ سفارش #${o.id} دوباره هم تحویل نشد و به «در انتظار بررسی» برگشت.${why}`);
      }
      if (o.status === 'settling') return fail('این سفارش همین الان در حال فعال‌سازی است. اگر تا ۱۰ دقیقه‌ی دیگر تمام نشد، «🔁 تلاش دوباره» را بزن.');
      if (!ORDER_OPEN.includes(o.status)) return fail(`وضعیت این سفارش «${o.status}» است و تأیید نمی‌شود.`);
      try { await settle(env, o); } catch (e) {
        return fail('⚠️ فعال نشد: ' + (e instanceof BillingError ? e.message : (e && e.message) || 'خطای ناشناخته'));
      }
      return { targetId: o.id, summary: `تأیید دستی · ${fa(o.amount_toman)} ت · ${o.method}`, text: `✅ سفارش #${o.id} تأیید و فعال شد.` };
    },
  },
  'order.reject': {
    risk: 'reversible', target: 'order',
    async apply(env, { orderId }) {
      const o = await orderRow(env, orderId);
      if (!o) return fail('سفارش پیدا نشد.');
      if (o.status === 'paid') return fail('این سفارش پرداخت و فعال شده؛ رد نمی‌شود. برای پس دادن پول «↩️ بازگشت به کیف پول» را بزن.');
      if (o.status === 'settling') return fail('این سفارش در حال فعال‌سازی است و رد نمی‌شود. اگر گیر کرده، «🔁 تلاش دوباره» را بزن.');
      if (!['pending', 'review', 'expired'].includes(o.status)) return fail(`وضعیت این سفارش «${o.status}» است.`);
      const r = await run(env, "UPDATE orders SET status = 'rejected', admin_note = ? WHERE id = ? AND status IN ('pending', 'review', 'expired')", REJECT_NOTE(o), o.id);
      if (!r.meta.changes) return fail('وضعیت سفارش همین الان عوض شد؛ دوباره نگاه کن.');
      return { targetId: o.id, summary: `${o.status} → rejected`, undo: { orderId: o.id, status: o.status, note: o.admin_note ?? null }, text: `❌ سفارش #${o.id} رد شد.` };
    },
    async undo(env, u) {
      const r = await run(env, `UPDATE orders SET status = ?, admin_note = ? WHERE id = ? AND status = 'rejected' AND ${TXID_FREE}`, u.status, u.note, u.orderId);
      return !!r.meta.changes;
    },
  },
  'order.cancel': {
    risk: 'reversible', target: 'order',
    async apply(env, { orderId }) {
      const o = await orderRow(env, orderId);
      if (!o) return fail('سفارش پیدا نشد.');
      if (!ORDER_OPEN.includes(o.status)) return fail(o.status === 'paid' ? 'سفارش پرداخت‌شده لغو نمی‌شود.' : `وضعیت این سفارش «${o.status}» است.`);
      const r = await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review', 'expired', 'rejected')", o.id);
      if (!r.meta.changes) return fail('وضعیت سفارش همین الان عوض شد؛ دوباره نگاه کن.');
      return { targetId: o.id, summary: `${o.status} → cancelled`, undo: { orderId: o.id, status: o.status }, text: `🚫 سفارش #${o.id} لغو شد.` };
    },
    async undo(env, u) {
      if (!ORDER_OPEN.includes(u.status)) return false;
      const r = await run(env, `UPDATE orders SET status = ? WHERE id = ? AND status = 'cancelled' AND ${TXID_FREE}`, u.status, u.orderId);
      return !!r.meta.changes;
    },
  },
  // once per order: wallet_tx is UNIQUE(order_id, reason), so a second try moves nothing and says so
  'order.refund': {
    risk: 'money', target: 'order',
    async apply(env, { orderId }) {
      const o = await orderRow(env, orderId);
      if (!o) return fail('سفارش پیدا نشد.');
      if (o.status !== 'paid') return fail('فقط سفارش پرداخت‌شده به کیف پول برمی‌گردد.');
      if (o.kind === 'topup') return fail('این سفارش شارژ کیف پول است؛ پولش همین الان در کیف پول کاربر است.');
      if (!(o.amount_toman > 0)) return fail('این سفارش مبلغی ندارد که برگردد.');
      if (await first(env, "SELECT 1 x FROM wallet_tx WHERE order_id = ? AND reason = 'admin_refund'", o.id)) return fail('این سفارش قبلاً به کیف پول برگردانده شده است.');
      const u = await userRow(env, o.user_id);
      if (!u) return fail('کاربر این سفارش پیدا نشد.');
      const { walletApply } = await import('./billing.js');
      await walletApply(env, u, o.amount_toman, 'admin_refund', o.id, `بازگشت وجه سفارش #${o.id}`);
      if (!u.wallet_applied) return fail('این سفارش قبلاً به کیف پول برگردانده شده است.');
      return { targetId: o.id, summary: `+${fa(o.amount_toman)} ت به کیف پول #${u.id}`,
        text: `↩️ ${fa(o.amount_toman)} تومان به کیف پول ${u.email} برگشت (موجودی: ${fa(u.wallet_balance)}). اشتراکش دست نخورد.` };
    },
  },

  // ---- plans: order, copy, delete / archive ----
  'plan.move': {
    risk: 'reversible', target: 'plan',
    async apply(env, { id, dir }) {
      const rows = await all(env, 'SELECT id, sort FROM plans WHERE archived = 0 ORDER BY sort, id');
      const i = rows.findIndex((r) => r.id === parseInt(id, 10));
      if (i < 0) return fail('پلن پیدا نشد.');
      const j = dir === 'u' ? i - 1 : i + 1;
      if (j < 0 || j >= rows.length) return fail(dir === 'u' ? 'همین الان اولین پلن است.' : 'همین الان آخرین پلن است.');
      const ids = rows.map((r) => r.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const before = Object.fromEntries(rows.map((r) => [r.id, r.sort]));
      const stmts = ids.map((pid, k) => [pid, (k + 1) * 10]).filter(([pid, s]) => before[pid] !== s).map(([pid, s]) => st(env, 'UPDATE plans SET sort = ? WHERE id = ?', s, pid));
      if (stmts.length) await env.DB.batch(stmts);
      return { targetId: rows[i].id, summary: `جای ${i + 1} → ${j + 1}`, undo: { sorts: before }, text: dir === 'u' ? '⬆️ بالاتر رفت' : '⬇️ پایین‌تر رفت' };
    },
    async undo(env, u) {
      const pairs = Object.entries(u.sorts || {});
      if (!pairs.length) return false;
      await env.DB.batch(pairs.map(([pid, s]) => st(env, 'UPDATE plans SET sort = ? WHERE id = ?', s, parseInt(pid, 10))));
      return true;
    },
  },
  'plan.copy': {
    risk: 'reversible', target: 'plan',
    async apply(env, { id }) {
      const p = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
      const nid = await insert(env, 'plans', { name: `${p.name} (کپی)`.slice(0, 60), duration_days: p.duration_days, data_limit_gb: p.data_limit_gb, device_limit: p.device_limit,
        price_toman: p.price_toman, old_price_toman: p.old_price_toman, badge: p.badge, description: p.description, trial_days: p.trial_days, sort: p.sort, is_active: 0, archived: 0 });
      return { targetId: nid, summary: `کپی از #${p.id}`, undo: { planId: nid }, text: `📋 پلن #${nid} ساخته شد (خاموش). عوضش کن و بعد روشنش کن.` };
    },
    undo: (env, u) => ACTIONS['plan.create'].undo(env, u),
  },
  'plan.delete': {
    risk: 'destructive', target: 'plan',
    async apply(env, { id }) {
      const p = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
      if (await planUses(env, p.id)) {
        if (p.archived) return fail('این پلن قبلاً بایگانی شده است.');
        await run(env, 'UPDATE plans SET archived = 1, is_active = 0 WHERE id = ?', p.id);
        return { targetId: p.id, archived: true, summary: `بایگانی ${p.name}`, text: `🗄 پلن ${p.name} بایگانی شد: در اپ و لیست‌ها دیده نمی‌شود، ولی اسمش در سفارش‌ها و اشتراک‌های قبلی می‌ماند.` };
      }
      await run(env, 'DELETE FROM plans WHERE id = ?', p.id);
      return { targetId: p.id, archived: false, summary: `حذف ${p.name}`, text: `🗑 پلن ${p.name} برای همیشه پاک شد (هیچ سفارش و اشتراکی نداشت).` };
    },
  },
  'plan.unarchive': {
    risk: 'reversible', target: 'plan',
    async apply(env, { id }) {
      const p = await first(env, 'SELECT id, name, archived FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
      if (!p.archived) return fail('این پلن بایگانی نیست.');
      await run(env, 'UPDATE plans SET archived = 0 WHERE id = ?', p.id);
      return { targetId: p.id, summary: 'archived: 1 → 0', undo: { id: p.id }, text: `📤 پلن ${p.name} از بایگانی برگشت (هنوز خاموش است).` };
    },
    async undo(env, u) {
      await run(env, 'UPDATE plans SET archived = 1, is_active = 0 WHERE id = ?', u.id);
      return true;
    },
  },

  // ---- coupons: edit one field, pause / resume ----
  'coupon.set': {
    risk: 'reversible', target: 'coupon',
    async apply(env, { id, field, value }) {
      const col = COUPON_FIELDS[field];
      if (!col) return fail('فیلد ناشناخته.');
      const c = await first(env, 'SELECT * FROM coupons WHERE id = ?', parseInt(id, 10));
      if (!c) return fail('این کد پیدا نشد.');
      const n = parseInt(value, 10);
      let val;
      if (col === 'percent') { if (!(n >= 1 && n <= 100)) return fail('درصد باید بین 1 و 100 باشد.'); val = n; }
      if (col === 'max_uses') { if (!(n >= 0 && n <= 1e6)) return fail('تعداد باید 0 (نامحدود) یا بیشتر باشد.'); val = n; }
      if (col === 'expires_at') { if (!(n >= 0 && n <= 3650)) return fail('روز باید بین 0 (همیشه) و 3650 باشد.'); val = n ? nowSec() + n * DAY : null; }
      if (col === 'plan_id') {
        if (!(n >= 0)) return fail('پلن درست نیست.');
        if (n && !(await first(env, 'SELECT 1 x FROM plans WHERE id = ? AND archived = 0', n))) return fail('این پلن پیدا نشد یا بایگانی است.');
        val = n || null;
      }
      await run(env, `UPDATE coupons SET ${col} = ? WHERE id = ?`, val, c.id);
      const nice = (v) => (v == null ? '—' : col === 'expires_at' ? ymd(v) : String(v));
      return { targetId: c.code, summary: `${col}: ${nice(c[col])} → ${nice(val)}`, undo: { id: c.id, col, value: c[col] ?? null }, text: `✅ کد ${c.code}: ${col} = ${nice(val)}` };
    },
    async undo(env, u) {
      if (!Object.values(COUPON_FIELDS).includes(u.col) && u.col !== 'is_active') return false;
      const r = await run(env, `UPDATE coupons SET ${u.col} = ? WHERE id = ?`, u.value, u.id);
      return !!r.meta.changes;
    },
  },
  'coupon.toggle': {
    risk: 'reversible', target: 'coupon',
    async apply(env, { id }) {
      const c = await first(env, 'SELECT id, code, is_active FROM coupons WHERE id = ?', parseInt(id, 10));
      if (!c) return fail('این کد پیدا نشد.');
      await run(env, 'UPDATE coupons SET is_active = ? WHERE id = ?', c.is_active ? 0 : 1, c.id);
      return { targetId: c.code, summary: `is_active: ${c.is_active} → ${c.is_active ? 0 : 1}`, undo: { id: c.id, col: 'is_active', value: c.is_active },
        text: c.is_active ? `⏸ کد ${c.code} متوقف شد` : `▶️ کد ${c.code} دوباره فعال شد` };
    },
    undo: (env, u) => ACTIONS['coupon.set'].undo(env, u),
  },
});

// ---------------- stage 4: panels, servers, the app's lists, network stats ----------------
export const SKEY_RE = /^[a-z0-9]{6,16}$/; // the key the apps send (serverKey: "k" + 8 hex)
export const APP_LISTS = { d: 'app_api_bases', b: 'app_bridges' };
const KEY_LABEL = { app_api_bases: 'دامنه‌های اپ', app_bridges: 'پل‌های اپ' };
const LIST_MAX = 8;
const BASE_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i;
const BRIDGE_RE = /^(vless|vmess|trojan|ss|hysteria2|hy2|wireguard):\/\/\S+$/i;
// a short tag of one list item (FNV-1a, 6 hex): a button names the item it was drawn for, so a stale button
// cannot remove or move a different item after the list changed
export function itemTag(v) {
  let h = 0x811c9dc5;
  for (const ch of String(v)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}
export const splitAppList = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
// a domain for the app's API: https, a host name, an optional port, nothing else (no path, user or query)
export function cleanBase(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  return BASE_RE.test(v) && v.length <= 200 ? v.toLowerCase() : null;
}
export function cleanBridge(raw) {
  const v = String(raw || '').trim();
  return BRIDGE_RE.test(v) && v.length <= 2000 && !/[,]/.test(v) ? v : null;
}
// "vless://ab•••com" — never the whole link, its id or its port
export function maskBridge(link) {
  const s = String(link || '');
  const scheme = (s.split('://', 1)[0] || '?').toLowerCase();
  let host = '';
  try {
    if (scheme === 'vmess') {
      let raw = s.slice(8).split('#')[0];
      raw += '='.repeat((4 - (raw.length % 4)) % 4);
      host = String(JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))).add || '');
    } else {
      const rest = s.replace(/^[a-z0-9+.-]+:\/\//i, '').split('#')[0].split('?')[0].split('/')[0];
      host = rest.slice(rest.lastIndexOf('@') + 1).replace(/^\[/, '').replace(/\](:\d*)?$/, '').replace(/:\d*$/, '');
    }
  } catch (e) { host = ''; }
  const m = host.length > 6 ? host.slice(0, 2) + '•••' + host.slice(-3) : '•••';
  return `${scheme}://${m}`;
}

const panelRow = async (env, id) => (await import('./panels.js')).getPanel(env, parseInt(id, 10));
// server_overrides: the row after a change, or deleted when it says nothing any more
async function writeOverride(env, panelId, key, hidden, label) {
  if (!hidden && !label) await run(env, 'DELETE FROM server_overrides WHERE panel_id = ? AND server_key = ?', panelId, key);
  else await run(env, `INSERT INTO server_overrides (panel_id, server_key, hidden, label) VALUES (?, ?, ?, ?)
    ON CONFLICT(panel_id, server_key) DO UPDATE SET hidden = excluded.hidden, label = excluded.label`, panelId, key, hidden ? 1 : 0, label || null);
}
const overrideOf = (env, panelId, key) => first(env, 'SELECT hidden, label FROM server_overrides WHERE panel_id = ? AND server_key = ?', panelId, key);

// what one network-stats reset removes: tables keyed by server (skey) or by operator (asn)
export const NET_RESET_TABLES = {
  s: ['net_stats', 'net_geo', 'net_votes', 'net_speed_votes', 'user_net_srv', 'google_probe', 'google_votes'],
  a: ['net_stats', 'net_geo', 'net_votes', 'net_speed_votes', 'user_net_srv', 'user_net'],
};
export function netResetTarget(kind, id) {
  if (kind === 's' && SKEY_RE.test(String(id))) return { col: 'skey', val: String(id), tables: NET_RESET_TABLES.s };
  const asn = parseInt(id, 10);
  if (kind === 'a' && asn > 0 && String(asn) === String(id)) return { col: 'asn', val: asn, tables: NET_RESET_TABLES.a };
  return null;
}
// rows a reset would remove, per table (one query)
export async function netResetImpact(env, kind, id) {
  const t = netResetTarget(kind, id);
  if (!t) return null;
  const row = await first(env, `SELECT ${t.tables.map((tb) => `(SELECT COUNT(*) FROM ${tb} WHERE ${t.col} = ?1) AS ${tb}`).join(', ')}`, t.val);
  return { ...t, counts: row, total: Object.values(row).reduce((a, b) => a + Number(b || 0), 0) };
}

Object.assign(ACTIONS, {
  'panel.rename': {
    risk: 'reversible', target: 'panel',
    async apply(env, { panelId, label }) {
      const p = await panelRow(env, panelId);
      if (!p) return fail('پنل پیدا نشد.');
      label = String(label || '').trim().replace(/\s+/g, ' ');
      if (!label || label.length > 40) return fail('نام پنل باید ۱ تا ۴۰ حرف باشد.');
      await run(env, 'UPDATE panels SET label = ? WHERE id = ?', label, p.id);
      return { targetId: p.id, summary: `${p.label} → ${label}`, undo: { panelId: p.id, label: p.label }, text: `✏️ نام پنل #${p.id}: ${label}` };
    },
    async undo(env, u) {
      const r = await run(env, 'UPDATE panels SET label = ? WHERE id = ?', String(u.label || '').slice(0, 40), u.panelId);
      return !!r.meta.changes;
    },
  },
  // a disabled panel goes back to testing (takes nobody until the admin rolls it out again)
  'panel.enable': {
    risk: 'reversible', target: 'panel',
    async apply(env, { panelId }) {
      const p = await panelRow(env, panelId);
      if (!p) return fail('پنل پیدا نشد.');
      if (p.state !== 'disabled') return fail('فقط پنل غیرفعال دوباره فعال می‌شود.');
      await run(env, "UPDATE panels SET state = 'testing', rollout_percent = 0 WHERE id = ? AND state = 'disabled'", p.id);
      return { targetId: p.id, summary: 'disabled → testing', undo: { panelId: p.id, pct: p.rollout_percent || 0 },
        text: `🔄 پنل #${p.id} به حالت «در حال تست» برگشت. هنوز به کسی داده نمی‌شود؛ اول تستش کن، بعد درصد بده.` };
    },
    async undo(env, u) {
      const r = await run(env, "UPDATE panels SET state = 'disabled', rollout_percent = ? WHERE id = ? AND state = 'testing'", u.pct || 0, u.panelId);
      return !!r.meta.changes;
    },
  },
  // ---------------- Pleat health reports (health.js) ----------------
  'health.resolve': {
    risk: 'reversible', target: 'health',
    async apply(env, { fp }) {
      const H = await import('./health.js');
      if (!H.FP_RE.test(String(fp))) return fail('این مورد پیدا نشد.');
      const ids = (await all(env, "SELECT id FROM health_events WHERE fp = ? AND state = 'open'", fp)).map((r) => r.id);
      await H.resolve(env, fp);
      return { targetId: fp, summary: `resolved ${ids.length} rows`, undo: { fp, ids: ids.slice(0, 200) },
        text: '✅ رسیدگی‌شده علامت خورد. اگر دوباره رخ بدهد، باز می‌شود.' };
    },
    async undo(env, u) { const H = await import('./health.js'); return H.reopen(env, u.fp, u.ids); },
  },
  'health.mute': {
    risk: 'reversible', target: 'health',
    async apply(env, { fp, on }) {
      const H = await import('./health.js');
      const r = await H.setMute(env, fp, !!on);
      if (!r) return fail('این مورد پیدا نشد.');
      return { targetId: fp, summary: `mute: ${r.before ? 1 : 0} → ${on ? 1 : 0}`, undo: { fp, on: !!r.before },
        text: on ? '🔇 تا ۷ روز این مشکل در فهرست و هشدارها نمی‌آید.' : '🔔 این مشکل دوباره نشان داده می‌شود.' };
    },
    async undo(env, u) { const H = await import('./health.js'); return !!(await H.setMute(env, u.fp, !!u.on)); },
  },
  'health.mode': {
    risk: 'reversible', target: 'health',
    async apply(env, { mode }) {
      const H = await import('./health.js');
      const r = await H.setMode(env, mode);
      if (!r) return fail('این حالت درست نیست.');
      return { targetId: 'mode', summary: `mode: ${r.before} → ${mode}`, undo: { mode: r.before }, text: `⚙️ ارسال گزارش از اپ: ${H.MODE_FA[mode]}` };
    },
    async undo(env, u) { const H = await import('./health.js'); return !!(await H.setMode(env, u.mode)); },
  },
  'server.hide': {
    risk: 'reversible', target: 'server',
    async apply(env, { panelId, key, on }) {
      const p = await panelRow(env, panelId);
      if (!p) return fail('پنل پیدا نشد.');
      if (!SKEY_RE.test(String(key))) return fail('سرور پیدا نشد.');
      const before = (await overrideOf(env, p.id, key)) || { hidden: 0, label: null };
      const hidden = on ? 1 : 0;
      await writeOverride(env, p.id, key, hidden, before.label);
      return { targetId: `${p.id}.${key}`, summary: `hidden: ${before.hidden ? 1 : 0} → ${hidden}`, undo: { panelId: p.id, key, hidden: before.hidden ? 1 : 0, label: before.label || null },
        text: hidden ? '🙈 این سرور از لیست اپ برداشته شد (کاربرها دیگر نمی‌بینندش).' : '👁 این سرور دوباره در لیست اپ است.' };
    },
    async undo(env, u) {
      if (!SKEY_RE.test(String(u.key))) return false;
      await writeOverride(env, parseInt(u.panelId, 10), u.key, u.hidden, u.label);
      return true;
    },
  },
  // label '' = back to the automatic name ("🇩🇪 DE 2"); the app is English only, so no Persian
  'server.rename': {
    risk: 'reversible', target: 'server',
    async apply(env, { panelId, key, label }) {
      const p = await panelRow(env, panelId);
      if (!p) return fail('پنل پیدا نشد.');
      if (!SKEY_RE.test(String(key))) return fail('سرور پیدا نشد.');
      let clean = null;
      if (String(label || '').trim()) {
        const { cleanServerLabel } = await import('./panels.js');
        clean = cleanServerLabel(label);
        if (!clean) return fail('نام سرور باید ۱ تا ۴۰ حرف انگلیسی، عدد یا ایموجی باشد (اپ انگلیسی است؛ حرف فارسی و # " < > قبول نمی‌شود).');
      }
      const before = (await overrideOf(env, p.id, key)) || { hidden: 0, label: null };
      await writeOverride(env, p.id, key, before.hidden, clean);
      return { targetId: `${p.id}.${key}`, summary: `label: ${before.label || '(خودکار)'} → ${clean || '(خودکار)'}`,
        undo: { panelId: p.id, key, hidden: before.hidden ? 1 : 0, label: before.label || null },
        text: clean ? `✏️ نام این سرور در اپ: ${clean}` : '✏️ نام این سرور به نام خودکار برگشت.' };
    },
    undo: (env, u) => ACTIONS['server.hide'].undo(env, u),
  },
  // the app's emergency lists: k = d (API domains) or b (bridge configs); op = add | remove | move
  'app.list': {
    risk: 'reversible', target: 'setting',
    async apply(env, { k, op, value, index, dir, tag }) {
      const key = APP_LISTS[k];
      if (!key) return fail('لیست ناشناخته.');
      const before = (await getSettings(env))[key] || '';
      const list = splitAppList(before);
      const i = parseInt(index, 10);
      if (op !== 'add' && tag != null && !(i >= 0 && i < list.length && itemTag(list[i]) === tag)) return fail('این لیست در این فاصله عوض شده؛ دوباره نگاه کن.');
      let text;
      if (op === 'add') {
        const v = k === 'd' ? cleanBase(value) : cleanBridge(value);
        if (!v) return fail(k === 'd' ? '❌ آدرس درست نیست. فقط https و نام دامنه، مثل https://api.example.com (بدون مسیر).'
          : '❌ کانفیگ درست نیست. باید با vless:// یا vmess:// یا trojan:// یا ss:// یا hysteria2:// یا wireguard:// شروع شود.');
        if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return fail('این مورد همین الان در لیست هست.');
        if (list.length >= LIST_MAX) return fail(`حداکثر ${LIST_MAX} مورد. اول یکی را حذف کن.`);
        list.push(v);
        text = k === 'd' ? `➕ دامنه اضافه شد: ${v}` : `➕ پل اضافه شد: ${maskBridge(v)}`;
      } else if (op === 'remove') {
        if (!(i >= 0 && i < list.length)) return fail('این مورد دیگر در لیست نیست.');
        const [gone] = list.splice(i, 1);
        text = `🗑 حذف شد: ${k === 'd' ? gone : maskBridge(gone)}`;
      } else if (op === 'move') {
        const j = dir === 'u' ? i - 1 : i + 1;
        if (!(i >= 0 && i < list.length) || j < 0 || j >= list.length) return fail('جابه‌جایی ممکن نیست.');
        [list[i], list[j]] = [list[j], list[i]];
        text = '⬆️ ترتیب عوض شد';
      } else return fail('کار ناشناخته.');
      const val = list.join('\n');
      await setSetting(env, key, val);
      const brief = (v) => (k === 'd' ? splitAppList(v).join(' ') || '(خالی)' : `${splitAppList(v).length} پل`);
      return { targetId: key, summary: `${op}: ${brief(before)} → ${brief(val)}`.slice(0, 300), undo: { key, value: before }, text };
    },
    undo: (env, u) => ACTIONS['setting.set'].undo(env, u),
  },
  // Pleat's in-app update (appupdate.js): announce the newest build, make it a must, or stop offering it
  'app.release': {
    risk: 'reversible', target: 'setting',
    async apply(env, { op }) {
      const { setRelease } = await import('./appupdate.js');
      const r = await setRelease(env, op);
      if (r.error) return fail('❌ ' + r.error);
      const n = r.next;
      const text = op === 'announce' ? `📢 نسخه‌ی ${n.version} به کاربرها اعلام شد. اپ‌ها وقتی باز شوند علامت و نوتیف آپدیت می‌بینند.`
        : op === 'force' ? (n.force ? '⚠️ آپدیت اجباری شد: صفحه‌ی آپدیت در اپ تا آپدیت نکنند بسته نمی‌شود.' : '✅ آپدیت دیگر اجباری نیست.')
          : '🛑 اعلام آپدیت برداشته شد؛ اپ‌ها دیگر آپدیتی نمی‌بینند.';
      return { targetId: 'app_release', summary: `${op}${n ? ` ${n.version} (${n.tag})${n.force ? ' اجباری' : ''}` : ''}`, undo: { value: r.before || '' }, text };
    },
    async undo(env, u) {
      const { saveRelease, cleanRelease } = await import('./appupdate.js');
      let rel = null;
      try { rel = u.value ? cleanRelease(JSON.parse(u.value)) : null; } catch (e) { rel = null; }
      await saveRelease(env, rel);
      return true;
    },
  },
  // removes the stats of one server (kind 's', id = skey) or one operator (kind 'a', id = asn), in one batch
  'net.reset': {
    risk: 'destructive', target: 'net',
    async apply(env, { kind, id }) {
      const t = netResetTarget(kind, id);
      if (!t) return fail('هدف پاک کردن درست نیست.');
      const res = await env.DB.batch(t.tables.map((tb) => st(env, `DELETE FROM ${tb} WHERE ${t.col} = ?`, t.val)));
      const n = res.reduce((a, r) => a + Number((r.meta && r.meta.changes) || 0), 0);
      return { targetId: `${kind}:${t.val}`, summary: `${fa(n)} ردیف از ${t.tables.join(',')}`,
        text: `🧹 آمار ${kind === 's' ? 'این سرور' : 'این اپراتور'} پاک شد (${fa(n)} ردیف). از گزارش‌های بعدی اپ دوباره جمع می‌شود.` };
    },
  },
});

// ---------------- broadcasts and admins (stage 5) ----------------
// Who a broadcast goes to. Always people who signed in with Telegram (a tg_id), whose account is active and not
// deleted; ?1 is "now". The same WHERE counts them for the question and picks them, a page at a time, in the cron.
export const AUDIENCES = {
  all: { fa: 'همه‌ی کاربران تلگرام', sql: '1 = 1' },
  active: { fa: 'اشتراک فعال', sql: 'EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = users.id AND (s.expires_at IS NULL OR s.expires_at > ?1))' },
  expired: { fa: 'اشتراک تمام‌شده', sql: 'EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = users.id AND s.expires_at IS NOT NULL AND s.expires_at <= ?1)' },
  none: { fa: 'بدون پلن', sql: 'NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = users.id)' },
};
// ("?1 > 0" keeps the ?1 parameter used when an audience itself does not need "now")
const REACHABLE = "users.tg_id IS NOT NULL AND users.is_active = 1 AND users.email NOT LIKE 'deleted+%' AND ?1 > 0";
export const BROADCAST_MAX = 3500;
export const BROADCAST_PAGE = 25; // messages per cron run (each one is a subrequest; Telegram allows ~30/s)
const LEASE_SECONDS = 90;

export async function audienceCount(env, aud, now = nowSec()) {
  const a = AUDIENCES[aud];
  if (!a) return 0;
  return (await first(env, `SELECT COUNT(*) c FROM users WHERE ${REACHABLE} AND (${a.sql})`, now)).c;
}

// One cron run: up to `max` messages of the broadcast that is sending, from its cursor on. A lease on updated_at
// keeps two runs from sending the same page; the counters and the cursor are saved in one UPDATE at the end.
// 403 = the person blocked the bot (counted, skipped); 429 = Telegram says slow down: stop here, the same person is
// tried again on the next run. Text goes out as plain text: no parse_mode, no buttons.
export async function broadcastTick(env, { max = BROADCAST_PAGE, now = nowSec() } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const bc = await first(env, "SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1");
  if (!bc || !AUDIENCES[bc.audience]) return null;
  const lease = await run(env, "UPDATE broadcasts SET updated_at = ? WHERE id = ? AND status = 'sending' AND updated_at <= ?", now, bc.id, now - LEASE_SECONDS);
  if (!lease.meta.changes) return { id: bc.id, busy: true };
  const rows = await all(env, `SELECT id, tg_id FROM users WHERE id > ?2 AND ${REACHABLE} AND (${AUDIENCES[bc.audience].sql}) ORDER BY id LIMIT ?3`, now, bc.cursor, max);
  const { tg } = await import('./telegram.js');
  let sent = 0, failed = 0, blocked = 0, cursor = bc.cursor, limited = false;
  for (const u of rows) {
    const r = await tg(env, 'sendMessage', { chat_id: u.tg_id, text: bc.text, disable_web_page_preview: true });
    const code = r && !r.ok ? Number(r.error_code) : 0;
    if (code === 429) { limited = true; break; }
    if (r && r.ok) sent++;
    else if (code === 403) blocked++;
    else failed++;
    cursor = u.id;
  }
  const done = !limited && rows.length < max;
  // a stop tapped while this page went out wins: the counters are kept, the status stays "stopped"
  await run(env, `UPDATE broadcasts SET sent = sent + ?, failed = failed + ?, blocked = blocked + ?, cursor = ?, updated_at = ?,
    status = CASE WHEN status = 'sending' AND ? = 1 THEN 'done' ELSE status END WHERE id = ?`, sent, failed, blocked, cursor, now - LEASE_SECONDS - 1, done ? 1 : 0, bc.id);
  if (done) {
    const f = await first(env, 'SELECT * FROM broadcasts WHERE id = ?', bc.id);
    if (f && f.status === 'done' && env.TELEGRAM_CHAT_ID) {
      await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: `📣 پیام همگانی #${f.id} تمام شد: ${fa(f.sent)} رسید، ${fa(f.blocked)} ربات را بلاک کرده‌اند، ${fa(f.failed)} ناموفق.`,
        reply_markup: { inline_keyboard: [[{ text: '📣 جزئیات', callback_data: `m:bcv:${f.id}` }]] } });
    }
  }
  return { id: bc.id, sent, failed, blocked, limited, done };
}

const ROLES = ['support', 'viewer'];
export const ROLE_FA = { owner: 'مالک', support: 'پشتیبان', viewer: 'فقط دیدن' };
const tgIdOf = (v) => { const s = String(v ?? '').trim(); return /^\d{5,15}$/.test(s) ? s : null; };

Object.assign(ACTIONS, {
  'broadcast.create': {
    risk: 'reversible', target: 'broadcast',
    async apply(env, { audience, text }) {
      text = String(text ?? '').trim();
      if (!AUDIENCES[audience]) return fail('گیرنده‌ها درست نیست.');
      if (!text || text.length > BROADCAST_MAX) return fail(`متن باید ۱ تا ${fa(BROADCAST_MAX)} حرف باشد.`);
      const now = nowSec();
      const id = await insert(env, 'broadcasts', { audience, text, cursor: 0, sent: 0, failed: 0, blocked: 0, status: 'draft', created_at: now, updated_at: now });
      return { targetId: id, summary: `${AUDIENCES[audience].fa} · ${fa(text.length)} حرف (پیش‌نویس)`, undo: { id }, text: `📝 پیش‌نویس #${id} ساخته شد.` };
    },
    async undo(env, u) { return !!(await run(env, "DELETE FROM broadcasts WHERE id = ? AND status = 'draft'", u.id)).meta.changes; },
  },
  // draft -> sending, only while no other broadcast is sending (one conditional UPDATE, so two taps start one)
  'broadcast.start': {
    risk: 'destructive', target: 'broadcast',
    async apply(env, { id }) {
      const b = await first(env, 'SELECT * FROM broadcasts WHERE id = ?', parseInt(id, 10));
      if (!b) return fail('این پیام پیدا نشد.');
      if (b.status !== 'draft') return fail('این پیام قبلاً شروع یا لغو شده است.');
      const now = nowSec();
      const r = await run(env, `UPDATE broadcasts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status = 'sending')`, now - LEASE_SECONDS - 1, b.id);
      if (!r.meta.changes) return fail('یک پیام همگانی دیگر در حال ارسال است؛ اول آن تمام یا متوقف شود.');
      const n = await audienceCount(env, b.audience, now);
      return { targetId: b.id, summary: `${AUDIENCES[b.audience].fa} · حدود ${fa(n)} نفر`,
        text: `📣 ارسال پیام #${b.id} شروع شد (حدود ${fa(n)} نفر). هر ۲ دقیقه ${fa(BROADCAST_PAGE)} نفر؛ پیشرفت را در «📣 پیام همگانی» ببین.` };
    },
  },
  'broadcast.stop': {
    risk: 'reversible', target: 'broadcast',
    async apply(env, { id }) {
      const r = await run(env, "UPDATE broadcasts SET status = 'stopped' WHERE id = ? AND status = 'sending'", parseInt(id, 10));
      if (!r.meta.changes) return fail('این پیام در حال ارسال نیست.');
      return { targetId: parseInt(id, 10), summary: 'sending → stopped', undo: { id: parseInt(id, 10) }, text: '⏹ ارسال متوقف شد.' };
    },
    async undo(env, u) {
      return !!(await run(env, `UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'stopped'
        AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status = 'sending')`, u.id)).meta.changes;
    },
  },
  // an extra admin: support (inbox and receipts) or viewer (read only). The owner is never in this table.
  'admin.add': {
    risk: 'reversible', target: 'admin',
    async apply(env, { tgId, role }) {
      const id = tgIdOf(tgId);
      if (!id) return fail('آیدی عددی تلگرام درست نیست (۵ تا ۱۵ رقم).');
      if (id === String(env.TELEGRAM_CHAT_ID || '')) return fail('این آیدی خود مالک است؛ مالک همیشه همه‌ی دسترسی‌ها را دارد.');
      if (!ROLES.includes(role)) return fail('نقش درست نیست.');
      const before = await first(env, 'SELECT * FROM admins WHERE tg_id = ?', id);
      await run(env, 'INSERT INTO admins (tg_id, role, added_at) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET role = excluded.role', id, role, nowSec());
      return { targetId: id, summary: `${before ? ROLE_FA[before.role] : '—'} → ${ROLE_FA[role]}`, undo: { id, before: before || null },
        text: `✅ ${id} حالا ${ROLE_FA[role]} است.` };
    },
    async undo(env, u) {
      if (!tgIdOf(u.id)) return false;
      if (u.before && ROLES.includes(u.before.role)) await run(env, 'UPDATE admins SET role = ? WHERE tg_id = ?', u.before.role, u.id);
      else await run(env, 'DELETE FROM admins WHERE tg_id = ?', u.id);
      return true;
    },
  },
  'admin.remove': {
    risk: 'reversible', target: 'admin',
    async apply(env, { tgId }) {
      const id = tgIdOf(tgId);
      if (!id) return fail('آیدی درست نیست.');
      if (id === String(env.TELEGRAM_CHAT_ID || '')) return fail('مالک حذف نمی‌شود.');
      const before = await first(env, 'SELECT * FROM admins WHERE tg_id = ?', id);
      if (!before) return fail('این آیدی مدیر نیست.');
      // with the row go their open question / form and their unused "are you sure?" buttons
      await env.DB.batch([st(env, 'DELETE FROM admins WHERE tg_id = ?', id), st(env, 'DELETE FROM bot_session WHERE admin_id = ?', id),
        st(env, 'UPDATE bot_confirm SET used_at = ? WHERE admin_id = ? AND used_at IS NULL', nowSec(), id)]);
      return { targetId: id, summary: `${ROLE_FA[before.role]} حذف شد`, undo: { id, role: before.role, added_at: before.added_at }, text: `🗑 ${id} دیگر مدیر نیست.` };
    },
    async undo(env, u) {
      if (!tgIdOf(u.id) || !ROLES.includes(u.role)) return false;
      await run(env, 'INSERT OR IGNORE INTO admins (tg_id, role, added_at) VALUES (?, ?, ?)', u.id, u.role, u.added_at || nowSec());
      return true;
    },
  },
});

// What a non-owner may write, checked again here under the router: support approves and rejects receipts only.
const ROLE_ACTIONS = { support: new Set(['order.approve', 'order.reject']), viewer: new Set() };
// ---------------- the Worker's error log, panel sync by hand ----------------
Object.assign(ACTIONS, {
  'cf.errors_clear': {
    risk: 'reversible', target: 'cf',
    async apply(env) {
      const n = (await run(env, 'DELETE FROM worker_errors')).meta.changes || 0;
      return { targetId: 'errors', summary: `${fa(n)} ردیف`, text: `🧹 لیست خطاها پاک شد (${fa(n)} نوع). خطاهای بعدی دوباره ثبت می‌شوند.` };
    },
  },
  // panel accounts that failed 3+ times wait for the next change; this lets the sync try them again now
  'sync.retry': {
    risk: 'reversible', target: 'sync',
    async apply(env) {
      const n = (await run(env, 'UPDATE panel_accounts SET attempts = 0 WHERE dirty = 1 AND attempts >= 3')).meta.changes || 0;
      return { targetId: 'retry', summary: `${fa(n)} اکانت`, text: n ? `🔁 ${fa(n)} اکانت به اول صف برگشت؛ همگام‌سازی بعدی (حداکثر یک دقیقه) امتحانشان می‌کند.` : 'اکانت گیرکرده‌ای نیست ✅' };
    },
  },
});

async function actorAllowed(env, actor, name) {
  if (String(actor) === String(env.TELEGRAM_CHAT_ID || '')) return true;
  const r = await first(env, 'SELECT role FROM admins WHERE tg_id = ?', String(actor));
  return !!(r && ROLE_ACTIONS[r.role] && ROLE_ACTIONS[r.role].has(name));
}

// a real, free email address (not a made-up Telegram one, not a deleted one)
export async function checkEmail(env, raw) {
  const { cleanNewEmail: cleanEmail } = await import('./util.js');
  const { TG_DOMAIN } = await import('./auth.js');
  let email;
  try { email = cleanEmail(raw); } catch (e) { return { error: 'این ایمیل درست نیست.' }; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '') || email.endsWith('@' + TG_DOMAIN) || email.endsWith('@invalid')) return { error: 'این ایمیل درست نیست.' };
  if (await first(env, 'SELECT 1 x FROM users WHERE email = ?', email)) return { error: 'این ایمیل برای حساب دیگری ثبت شده است.' };
  return { email };
}

export const riskOf = (name) => (ACTIONS[name] ? ACTIONS[name].risk : null);

// Apply one action and log it. Returns {ok, text, auditId, undoable, ...what the action returned}, or
// {ok: false, error} without changing anything. Panel errors from user.grant are thrown.
export async function runAction(env, actor, name, args = {}) {
  const def = ACTIONS[name];
  if (!def) throw new Error('unknown admin action ' + name);
  if (!(await actorAllowed(env, actor, name))) return fail('اجازه‌ی این کار را نداری.');
  const r = await def.apply(env, args);
  if (r.ok === false) return r;
  if (r.skipAudit) return { ok: true, ...r, auditId: null, undoable: false };
  const undo = def.risk === 'reversible' && def.undo && r.undo ? JSON.stringify(r.undo) : null;
  const auditId = await insert(env, 'admin_audit', { admin_id: String(actor), action: name, target_type: def.target || null,
    target_id: r.targetId == null ? null : String(r.targetId), summary: r.summary ? String(r.summary).slice(0, 300) : null, undo_json: undo, created_at: nowSec() });
  return { ok: true, ...r, auditId, undoable: !!undo };
}

export const canUndo = (row, now = nowSec()) => !!(row && row.undo_json && !row.undone_at && row.created_at >= now - UNDO_SECONDS);

// Put one reversible change back: only the admin who made it, once, within UNDO_SECONDS.
// The claim is one conditional UPDATE, so two taps cannot undo twice.
export async function undoAction(env, actor, auditId) {
  const now = nowSec();
  const claim = await run(env, `UPDATE admin_audit SET undone_at = ? WHERE id = ? AND admin_id = ? AND undone_at IS NULL
    AND undo_json IS NOT NULL AND created_at >= ?`, now, parseInt(auditId, 10), String(actor), now - UNDO_SECONDS);
  if (!claim.meta.changes) return fail('این تغییر دیگر برگشت‌پذیر نیست (بیش از ۱۰ دقیقه گذشته یا قبلاً برگردانده شده).');
  const row = await first(env, 'SELECT * FROM admin_audit WHERE id = ?', parseInt(auditId, 10));
  const def = ACTIONS[row.action];
  let done = false;
  try { done = !!(def && def.undo && (await def.undo(env, JSON.parse(row.undo_json)))); } catch (e) { done = false; }
  if (!done) return fail('برگرداندن ممکن نشد (مثلاً این مورد در این فاصله استفاده شده است).');
  await insert(env, 'admin_audit', { admin_id: String(actor), action: row.action + '.undo', target_type: row.target_type, target_id: row.target_id,
    summary: `برگشت #${row.id}`, undo_json: null, created_at: now });
  return { ok: true, row, text: `↩️ برگردانده شد: ${row.action}${row.target_id ? ` (${row.target_id})` : ''}` };
}
