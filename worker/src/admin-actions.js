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
const MASKED = new Set(['sms_key']); // never shown in the log
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
      const p = await first(env, 'SELECT id, is_active FROM plans WHERE id = ?', parseInt(id, 10));
      if (!p) return fail('پلن پیدا نشد.');
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
      let text = `✅ ${key} = ${val || '(خالی)'}`;
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

export const riskOf = (name) => (ACTIONS[name] ? ACTIONS[name].risk : null);

// Apply one action and log it. Returns {ok, text, auditId, undoable, ...what the action returned}, or
// {ok: false, error} without changing anything. Panel errors from user.grant are thrown.
export async function runAction(env, actor, name, args = {}) {
  const def = ACTIONS[name];
  if (!def) throw new Error('unknown admin action ' + name);
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
