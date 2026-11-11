// Public config, plans, profile, the VPN subscription (from the control plane), the unified server list, devices and the free trial.
import { first, all, run, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec, deadline } from './util.js';
import { PasarGuard, PasarGuardError } from './pasarguard.js';
import { provision } from './billing.js';
import { collectLinks } from './panels.js';
import { countryFromRemark } from './countries.js';
import { refreshUser, usedBytes, ensureMissingFor } from './sync.js';
import { cryptoEnabled } from './nowpayments.js';
import { enabledCoins, coinOut } from './coins.js';
import { notifyAdmin, untrusted } from './telegram.js';
import { profileOut } from './auth.js';

export async function appConfig(env) {
  const s = await getSettings(env);
  return json({
    support_url: s.support_url,
    announcement: s.announcement,
    card_enabled: !!s.card_number,
    card_auto: !!s.card_number && s.card_auto !== 'off' && !!String(s.sms_senders || '').trim(),
    crypto_enabled: cryptoEnabled(env) && parseInt(s.usdt_rate_toman, 10) > 0,
    coins: await (async () => {
      const { autoCoins, autoMode } = await import('./chainwatch.js');
      const mode = await autoMode(env);
      return (await enabledCoins(env)).map((c) => ({ ...coinOut(c), auto: mode !== 'off' && autoCoins().includes(c.id) }));
    })(),
    min_topup_toman: parseInt(s.min_topup_toman, 10) || 0,
    referral_percent: parseInt(s.referral_percent, 10) || 0,
    // ways around filtering, kept by the app for its next launch (see app_api_bases / app_bridges)
    api_bases: splitList(s.app_api_bases).filter((b) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(b)).slice(0, 8),
    bridges: splitList(s.app_bridges).filter((l) => /^(vless|vmess|trojan|ss|hysteria2|hy2|wireguard):\/\//i.test(l)).slice(0, 8),
    // the Pleat build the admin announced in the bot (null = none); the app compares the build number
    update: await (async () => { const u = await import('./appupdate.js'); return u.updateOut(await u.announced(env, s)); })(),
  });
}

const splitList = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

// the seeded plans were English; show friendly Persian names until the admin renames them
const FA_NAMES = { monthly: 'یک ماهه', annual: 'یک ساله', '6 month': 'شش ماهه', '3 month': 'سه ماهه' };
const FA_BADGES = { recommended: 'پیشنهاد ویژه', popular: 'محبوب', 'best value': 'به‌صرفه‌ترین' };
const faName = (n) => FA_NAMES[String(n || '').trim().toLowerCase()] || n;
const faBadge = (b) => FA_BADGES[String(b || '').trim().toLowerCase()] || b;
export const planName = faName;

function planOut(p) {
  const months = Math.max(1, Math.round(p.duration_days / 30));
  let save = 0;
  if (p.old_price_toman && p.old_price_toman > p.price_toman) save = Math.round((100 * (p.old_price_toman - p.price_toman)) / p.old_price_toman);
  return {
    id: p.id, name: faName(p.name), duration_days: p.duration_days, data_limit_gb: p.data_limit_gb,
    device_limit: p.device_limit, price_toman: p.price_toman, old_price_toman: p.old_price_toman,
    monthly_toman: Math.floor(p.price_toman / months), save_percent: save, badge: faBadge(p.badge),
    description: p.description, trial_days: p.trial_days,
  };
}

export async function plans(env) {
  const rows = await all(env, 'SELECT * FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id');
  return json(rows.map(planOut));
}

// Subscription as the app shows it. The control plane decides; with live = true every panel of the user is read
// first (so the numbers are fresh and a stop on quota happens right away). Nothing here names a panel.
// withSubUrl: only app versions before 1.9.0 still get the panel link (they download from it themselves).
// ctx (a request's): the live reading gets LIVE_BUDGET_MS; a panel that is slower (down, or far away) does not hold
// the answer: the stored numbers are sent (the sync job keeps them a few minutes fresh) and the reading finishes
// after the answer, so the next call has it.
export const LIVE_BUDGET_MS = 1500;
export async function subscriptionOut(env, user, live = true, { withSubUrl = false, ctx = null } = {}) {
  let sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  if (!sub) return null;
  let liveOk = false, missing = false;
  if (live) {
    const reading = refreshUser(env, user.id).catch(() => null); // stale numbers are still right numbers
    let timer;
    const late = ctx ? new Promise((resolve) => { timer = setTimeout(() => resolve('late'), LIVE_BUDGET_MS); }) : null;
    const r = late ? await Promise.race([reading, late]) : await reading;
    clearTimeout(timer);
    if (r === 'late') ctx.waitUntil(reading);
    else if (r) {
      liveOk = r.reached > 0;
      missing = r.accounts > 0 && r.missing === r.accounts;
    }
    sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  }
  const plan = sub.plan_id ? await first(env, 'SELECT * FROM plans WHERE id = ?', sub.plan_id) : null;
  const now = nowSec();
  const expires = sub.expires_at, dataLimit = sub.data_limit_bytes;
  const used = sub.period_id ? await usedBytes(env, sub.period_id) : 0;
  let status = 'active';
  if (missing) status = 'missing';
  else if (sub.state === 'stopped') status = STOP_STATUS[sub.stop_reason] || 'disabled';
  else if (expires && expires <= now) status = 'expired';
  else if (dataLimit && used >= dataLimit) status = 'limited';
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400)) : null;
  const usable = status === 'active';
  const out = {
    active: usable, status, stop_reason: usable ? null : (sub.stop_reason || (status === 'expired' ? 'expired' : status === 'limited' ? 'quota' : null)),
    live: liveOk, plan_name: plan ? faName(plan.name) : null,
    expires_at: expires ? new Date(expires * 1000).toISOString() : null, days_left: daysLeft,
    seconds_left: expires ? Math.max(0, expires - now) : null,
    unlimited_time: !expires, unlimited_data: !dataLimit,
    data_limit_bytes: dataLimit, used_bytes: used, remaining_bytes: dataLimit ? Math.max(0, dataLimit - used) : null,
    // whole percent of the data used (0-100, rounded down so 100 means really used up); null when data is unlimited.
    // The app shows its 80/95/100% warnings from this number instead of working it out itself.
    used_percent: dataLimit ? Math.min(100, Math.floor((used * 100) / dataLimit)) : null,
    device_limit: sub.device_limit, period_days: sub.period_days || (plan ? plan.duration_days : null),
  };
  if (withSubUrl) out.sub_url = status === 'missing' ? '' : sub.sub_url;
  return out;
}
const STOP_STATUS = { quota: 'limited', expired: 'expired', admin: 'disabled' };

// "1.9.0 (Android 14)" -> true for 1.9.0 and newer; a missing or unreadable version counts as old
export function centralApp(request) {
  const m = String((request && request.headers.get('x-app-version')) || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const [maj, min] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return maj > 1 || (maj === 1 && min >= 9);
}

async function trialAvailable(env, user) {
  if (user.trial_used) return false;
  const has = await first(env, 'SELECT id FROM subscriptions WHERE user_id = ?', user.id);
  return !has;
}

export async function me(env, user, request, ctx = null) {
  return json({
    ...profileOut(user),
    wallet_balance: user.wallet_balance, referral_code: user.referral_code,
    created_at: new Date(user.created_at * 1000).toISOString(),
    trial_available: await trialAvailable(env, user),
    // the Mini App never gets the panel subscription address (only the old app did)
    subscription: await subscriptionOut(env, user, true, { withSubUrl: !user._mini && !centralApp(request), ctx }),
  });
}

// GET /me/packages: every package the person has had, newest first, for the profile screen. A package is one
// period of the control plane: bought (with its order), a free trial, given by support, or brought in from an
// existing panel account. purchased_at is when it was paid; activated_at is when it started counting.
const SOURCES = ['order', 'trial', 'gift', 'panel'];
export async function packages(env, user) {
  const rows = await all(env, `SELECT p.*, o.created_at o_created, o.paid_at o_paid, o.amount_toman o_amount, o.method o_method
    FROM sub_periods p LEFT JOIN orders o ON o.id = p.order_id AND o.user_id = p.user_id
    WHERE p.user_id = ? ORDER BY p.started_at DESC, p.id DESC LIMIT 50`, user.id);
  const sub = await first(env, 'SELECT period_id FROM subscriptions WHERE user_id = ?', user.id);
  const plans = {};
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
  const out = [];
  for (const r of rows) {
    if (r.plan_id && !(r.plan_id in plans)) plans[r.plan_id] = await first(env, 'SELECT name, duration_days, data_limit_gb, device_limit FROM plans WHERE id = ?', r.plan_id);
    const plan = r.plan_id ? plans[r.plan_id] : null;
    let source = SOURCES.includes(r.source) ? r.source : null;
    if (!source) source = r.order_id ? 'order' : r.legacy ? 'panel' : !r.plan_id ? 'panel' : 'gift'; // rows from before 0015
    const current = !!sub && sub.period_id === r.id;
    const days = r.expires_at ? Math.max(1, Math.round((r.expires_at - r.started_at) / 86400)) : null;
    out.push({
      id: r.id, source, current,
      name: plan ? planName(plan.name) : (source === 'panel' ? 'Existing account' : 'Package'),
      order_id: r.order_id || null,
      purchased_at: source === 'order' ? iso(r.o_paid || r.o_created) : null,
      activated_at: iso(r.started_at),
      expires_at: iso(r.expires_at),
      ended_at: iso(r.ended_at), end_reason: r.end_reason || null,
      days, data_limit_bytes: r.limit_bytes || 0,
      used_bytes: current ? await usedBytes(env, r.id) : (r.final_used_bytes ?? null),
      amount_toman: source === 'order' ? (r.o_amount ?? null) : null,
      method: source === 'order' ? (r.o_method || null) : null,
      device_limit: plan ? plan.device_limit : null,
    });
  }
  return json(out);
}

// GET /me/photo: the person's Telegram profile picture (small size), fetched by the Worker so the app shows it
// even where Telegram is blocked. { photo: base64 | null }. Telegram only shows it to the bot when the person's
// privacy settings allow; otherwise the app keeps the initial.
export async function photo(env, user) {
  const none = json({ photo: null });
  if (!user.tg_id || !env.TELEGRAM_BOT_TOKEN) return none;
  const { tg } = await import('./telegram.js');
  const r = await tg(env, 'getUserProfilePhotos', { user_id: user.tg_id, limit: 1 });
  const sizes = r && r.ok && r.result && r.result.photos && r.result.photos[0];
  if (!Array.isArray(sizes) || !sizes.length) return none;
  const pick = [...sizes].sort((a, b) => (a.width || 0) - (b.width || 0)).find((x) => (x.width || 0) >= 160) || sizes[sizes.length - 1];
  const f = await tg(env, 'getFile', { file_id: pick.file_id });
  const path = f && f.ok && f.result && f.result.file_path;
  if (!path || (f.result.file_size || 0) > 200000) return none;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`, { signal: deadline(8000) });
    if (!res.ok) return none;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 200000) return none;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return new Response(JSON.stringify({ photo: btoa(bin) }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=86400' },
    });
  } catch (e) { return none; }
}

export function myIp(env, request) {
  return json({ ip: request.headers.get('cf-connecting-ip') || '' });
}

// ---------------- VPN ----------------
function parseLink(index, link) {
  const scheme = link.split('://', 1)[0].toLowerCase();
  let name = '';
  if (scheme === 'vmess') {
    try {
      let raw = link.split('://')[1];
      raw += '='.repeat((4 - (raw.length % 4)) % 4);
      name = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))).ps || '';
    } catch (e) { name = ''; }
  } else {
    const frag = link.split('#')[1] || '';
    try { name = decodeURIComponent(frag); } catch (e) { name = frag; }
  }
  const cc = countryFromRemark(name);
  const clean = name.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/u, '').replace(/^[\s\-|·]+|[\s\-|·]+$/g, '');
  return { index, name: clean || `Server ${index + 1}`, country_code: cc, protocol: scheme, link };
}

async function activeSub(env, user) {
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  if (!sub) throw err(402, 'no_subscription', 'برای استفاده از VPN یک پلن بخر یا تست رایگان را فعال کن.');
  return sub;
}

async function checkDevice(env, user, sub, deviceId, model) {
  if (!deviceId) return;
  const dev = await first(env, 'SELECT * FROM devices WHERE user_id = ? AND device_id = ?', user.id, deviceId);
  if (!dev && sub.device_limit) {
    const since = nowSec() - 30 * 86400;
    const countRow = await first(env, 'SELECT COUNT(*) c FROM devices WHERE user_id = ? AND last_seen >= ?', user.id, since);
    if (countRow.c >= sub.device_limit) throw err(403, 'device_limit', `این پلن روی ${sub.device_limit} گوشی کار می‌کند. یک گوشی قدیمی را از «اشتراک من» حذف کن.`);
  }
  await run(env, `INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen = excluded.last_seen`, user.id, deviceId, model || '', nowSec());
}

export async function vpn(env, user, request, ctx = null) {
  const sub = await activeSub(env, user);
  await checkDevice(env, user, sub, request.headers.get('x-device-id'), request.headers.get('x-device-model'));
  const out = await subscriptionOut(env, user, true, { withSubUrl: !centralApp(request), ctx });
  if (out.status === 'missing') throw err(410, 'sub_missing', 'اکانت شما روی سرور پیدا نشد. با پشتیبانی تماس بگیر.');
  return json({ subscription: out, remarks: 'Cloud Gold' });
}

const fwdHeaders = (H) => ({ 'x-hwid': H.get('x-hwid'), 'x-device-os': H.get('x-device-os'), 'x-ver-os': H.get('x-ver-os'), 'x-device-model': H.get('x-device-model') });

// The one server list: configs from every panel the user is on, renamed and merged by the Worker. The app
// imports this body into v2rayNG; it never learns where the configs came from.
export async function vpnSub(env, user, request) {
  const sub = await activeSub(env, user);
  const H = request.headers;
  await checkDevice(env, user, sub, H.get('x-device-id'), H.get('x-device-model'));
  const r = await unifiedLinks(env, user, fwdHeaders(H));
  const s = await subscriptionOut(env, user, false);
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  // v2rayNG reads usage and expiry from this header; it is the control plane's total, not one panel's
  headers['subscription-userinfo'] = `upload=0; download=${s.used_bytes}; total=${s.data_limit_bytes || 0}; expire=${sub.expires_at || 0}`;
  return new Response(r.links.join('\n'), { status: 200, headers });
}

async function unifiedLinks(env, user, fwd) {
  // a panel added since this user's last visit: their account there is made now, so its configs come at once
  try { await ensureMissingFor(env, user.id); } catch (e) { /* the cron job makes it later */ }
  const r = await collectLinks(env, user.id, fwd);
  if (!r.accounts) throw err(404, 'no_servers', 'برای اشتراک شما هنوز سروری تعریف نشده است.');
  if (r.deviceLimit && !r.links.length) throw err(403, 'device_limit', 'این اشتراک روی حداکثر تعداد گوشی استفاده شده است.');
  if (r.missing === r.accounts) throw err(410, 'sub_missing', 'اکانت شما روی سرور پیدا نشد. با پشتیبانی تماس بگیر.');
  if (!r.links.length) throw err(503, 'panel_unavailable', 'الان به سرورها دسترسی نداریم. چند دقیقه دیگر دوباره امتحان کن.');
  return r;
}

export async function vpnServers(env, user, request) {
  await activeSub(env, user);
  const r = await unifiedLinks(env, user, request ? fwdHeaders(request.headers) : {});
  // tunnel = the config enters through Iran (a panel's "Tunnel" group). panel = which panel it came from.
  // Both are shown to every user (Ali, 2026-11-11).
  const list = r.links.map((link, i) => {
    const s = parseLink(i, link);
    const m = r.meta?.[i];
    if (m?.tunnel) s.tunnel = true;
    if (m?.panel) s.panel = m.panel;
    return s;
  });
  try { const { rememberKeys } = await import('./netstats.js'); await rememberKeys(env, user, list); } catch (e) { /* stats only */ }
  return json(list);
}

export async function devices(env, user) {
  const rows = await all(env, 'SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC', user.id);
  return json(rows.map((d) => ({ id: d.id, device_id: d.device_id, model: d.model, last_seen: new Date(d.last_seen * 1000).toISOString() })));
}

export async function removeDevice(env, user, devId) {
  const dev = await first(env, 'SELECT * FROM devices WHERE id = ?', devId);
  if (!dev || dev.user_id !== user.id) throw err(404, 'not_found', 'این دستگاه پیدا نشد.');
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  if (sub && env.PASARGUARD_URL) {
    try { await new PasarGuard(env).deleteHwid(sub.pg_username, dev.device_id); } catch (e) {}
  }
  await run(env, 'DELETE FROM devices WHERE id = ?', devId);
  return new Response(null, { status: 204 });
}

export async function startTrial(env, user, body, request) {
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
  if (!plan || !plan.is_active || plan.archived || plan.trial_days <= 0) throw err(400, 'no_trial', 'این پلن تست رایگان ندارد.');
  if (!(await trialAvailable(env, user))) throw err(400, 'trial_used', 'تست رایگان را قبلاً استفاده کرده‌ای.');
  if (!user.tg_id && String((await getSettings(env)).trial_needs_telegram ?? '1') !== '0') {
    throw err(403, 'trial_needs_telegram', 'برای تست رایگان اول تلگرامت را در پروفایل تأیید کن.');
  }
  const deviceId = request.headers.get('x-device-id');
  if (deviceId) {
    const reused = await first(env, 'SELECT u.id FROM users u JOIN devices d ON d.user_id = u.id WHERE d.device_id = ? AND u.trial_used = 1 AND u.id != ?', deviceId, user.id);
    if (reused) throw err(400, 'trial_used', 'روی این گوشی قبلاً تست رایگان استفاده شده است.');
  }
  const trialGb = await getSettingInt(env, 'trial_data_gb');
  // claim the trial before building it, so two requests at the same moment cannot both get one
  const claim = await run(env, 'UPDATE users SET trial_used = 1 WHERE id = ? AND trial_used = 0', user.id);
  if (!claim.meta.changes) throw err(400, 'trial_used', 'تست رایگان را قبلاً استفاده کرده‌ای.');
  try {
    await provision(env, user, plan, { days: plan.trial_days, dataGb: trialGb > 0 ? trialGb : undefined, source: 'trial' });
  } catch (e) {
    await run(env, 'UPDATE users SET trial_used = 0 WHERE id = ?', user.id); // not built: the trial is still theirs
    if (e instanceof PasarGuardError) {
      await notifyAdmin(env, `⚠️ تست رایگان برای ${user.email} ساخته نشد.\n\nخطای پنل:\n${untrusted(e.message)}\n\nبرای عیب‌یابی /panel را بزن.`);
      throw err(503, 'provision_failed', 'فعال‌سازی تست رایگان الان ممکن نشد. پشتیبانی خبردار شد؛ چند دقیقه دیگر دوباره امتحان کن.');
    }
    throw e;
  }
  if (deviceId) {
    const d = await first(env, 'SELECT id FROM devices WHERE user_id = ? AND device_id = ?', user.id, deviceId);
    if (!d) await run(env, 'INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?,?,?,?)', user.id, deviceId, request.headers.get('x-device-model') || '', nowSec());
  }
  await notifyAdmin(env, `🎁 تست رایگان: ${user.email} (${plan.trial_days} روز از ${faName(plan.name)}${trialGb > 0 ? `، ${trialGb} گیگ` : ''})`);
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return me(env, fresh);
}

// ---------------- Telegram Mini App, stage 0: can the page open in Iran at all? ----------------
// A Mini App page is loaded by the phone's own web view over the normal internet, not through Telegram's proxy,
// so a filtered domain would not open even when Telegram itself works. This throw-away probe page answers that
// before any real Mini App is built: the admin opens it from the bot (📱 اپ Pleat › 🧪 تست Mini App) once per
// domain, on each operator, with the VPN off, and the page reports what it could reach back to the bot.

// The Worker's https addresses the probe can be opened on: PUBLIC_BASE_URL, then the extra API domains.
export async function miniBases(env) {
  const s = await getSettings(env);
  const list = [String(env.PUBLIC_BASE_URL || ''), ...splitList(s.app_api_bases)]
    .map((b) => b.trim().replace(/\/+$/, '').toLowerCase())
    .filter((b) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(b));
  return [...new Set(list)].slice(0, 8);
}

const PROBE_CSP = "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org";

export async function miniProbePage(env, request) {
  const origin = new URL(request.url).origin.toLowerCase();
  const others = (await miniBases(env)).filter((b) => b !== origin);
  const data = JSON.stringify({ others }).replace(/</g, '\\u003c');
  return new Response(PROBE_HTML.replace('/*DATA*/null', data), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PROBE_CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
  });
}

const msOf = (v) => (Number.isFinite(v) && v >= 0 && v < 120000 ? Math.round(v) : null);

// POST /api/v1/mini/probe {init_data, origin, steps: {page|telegram|api|sdk: {ok, ms}}, others: [{base, ok, ms}]}
// Only a page opened from Telegram (a valid initData) can report, so strangers cannot write into the admin chat.
export async function miniProbeReport(env, body, request) {
  const { verifyInitData } = await import('./auth.js');
  const v = await verifyInitData(env.TELEGRAM_BOT_TOKEN, body?.init_data, 86400);
  if (!v) throw err(401, 'bad_init_data', 'Open this page from the Telegram bot.');
  const bases = await miniBases(env);
  const host = (b) => b.replace(/^https:\/\//, '');
  const origin = String(body?.origin || '').toLowerCase();
  const steps = body && typeof body.steps === 'object' && body.steps ? body.steps : {};
  const mark = (s) => (s && s.ok === true ? `✅ ${msOf(s.ms) ?? '?'}ms` : '❌');
  const others = (Array.isArray(body?.others) ? body.others : []).filter((o) => o && bases.includes(String(o.base))).slice(0, 8);
  const { ispOf } = await import('./netstats.js');
  const net = ispOf(request);
  const u = v.user;
  const who = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40);
  const platform = String(body?.platform || '').replace(/[^\w.-]/g, '').slice(0, 20);
  const lines = [
    '🧪 نتیجه‌ی تست Mini App',
    `👤 ${untrusted(who)}${u.username ? ' @' + untrusted(String(u.username).slice(0, 32)) : ''} (${u.id})`,
    `📶 ${net.isp}${net.geoFa ? ' · ' + net.geoFa : ''}${net.country ? ' · ' + net.country : ''} · ${platform || '?'}`,
    `🌐 دامنه: ${bases.includes(origin) ? host(origin) : 'نامشخص'}`,
    '',
    `صفحه باز شد: ${mark(steps.page)}`,
    `داده‌ی تلگرام (initData): ${mark(steps.telegram)}`,
    `API همین دامنه: ${mark(steps.api)}`,
    `اسکریپت telegram.org: ${mark(steps.sdk)}`,
    ...(others.length ? ['', 'دامنه‌های دیگر از همین گوشی:', ...others.map((o) => `${o.ok === true ? '✅' : '❌'} ${host(o.base)}${o.ok === true ? ` ${msOf(o.ms) ?? '?'}ms` : ''}`)] : []),
  ];
  await notifyAdmin(env, lines.join('\n'));
  return json({ ok: true });
}

// The page: no build step, no outside file except the optional telegram.org script (whose loading is one of
// the things being measured). Colours are Pleat's day/night palette (direction A). English, like Pleat.
const PROBE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pleat · connection test</title>
<style>
:root{--ground:#E7F1FA;--surface:#FFFFFF;--field:#F2F6FB;--navy:#14284B;--blue:#2F89F5;--ink:#16181D;--muted:#8B93A7;--accent:#1E74DB;--safe:#1F9D55;--alert:#E5484D}
:root.night{--ground:#04080F;--surface:#060D18;--field:#081120;--navy:#2C3E5D;--ink:#F2F3F5;--muted:#9CA2B0;--accent:#4E9BF6}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px 16px 32px}
.card{background:var(--surface);border-radius:30px;padding:22px 20px;max-width:520px;margin:0 auto 14px}
h1{font-size:22px;margin:0 0 4px}p{margin:0;color:var(--muted);font-size:14px}
.mark{width:44px;height:44px;margin-bottom:14px;position:relative}.mark i{position:absolute;width:28px;height:34px;border-radius:6px;transform:skewX(-14deg)}
.mark i:first-child{left:4px;top:6px;background:var(--navy)}.mark i:last-child{left:14px;top:2px;background:var(--blue);opacity:.9}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--field)}li:last-child{border:0}
.s{font-weight:600;white-space:nowrap}.ok{color:var(--safe)}.no{color:var(--alert)}.wait{color:var(--muted)}
button{width:100%;border:0;border-radius:999px;padding:15px;font:600 16px system-ui,sans-serif;background:var(--blue);color:#fff;min-height:48px}
button:active{background:var(--accent)}#note{margin-top:12px;text-align:center}
@media (prefers-reduced-motion:no-preference){.wait{animation:p 1.2s ease-in-out infinite}@keyframes p{50%{opacity:.4}}}
</style></head><body>
<div class="card"><div class="mark" aria-hidden="true"><i></i><i></i></div>
<h1>Connection test</h1><p>Checks whether this page and Pleat's server can be reached from your network. Turn the VPN off first.</p></div>
<div class="card"><ul id="list"></ul></div>
<div class="card"><button id="copy" type="button">Copy report</button><p id="note" role="status"></p></div>
<script>
(function(){
var CFG=/*DATA*/null;var t0=performance.now();var night=false;
var h=new URLSearchParams(location.hash.slice(1));var initData=h.get('tgWebAppData')||'';var platform=h.get('tgWebAppPlatform')||'';
try{var tp=JSON.parse(h.get('tgWebAppThemeParams')||'{}');if(tp.bg_color){var c=parseInt(tp.bg_color.slice(1),16);night=((c>>16&255)*299+(c>>8&255)*587+(c&255)*114)/1000<128}else{night=matchMedia('(prefers-color-scheme: dark)').matches}}catch(e){}
if(night)document.documentElement.classList.add('night');
var R={page:{ok:true,ms:Math.round(t0)},telegram:{ok:!!initData},api:null,sdk:null};var others=[];
var list=document.getElementById('list');
function row(id,label){var li=document.createElement('li');li.innerHTML='<span></span><span class="s wait">checking…</span>';li.firstChild.textContent=label;li.id='r-'+id;list.appendChild(li)}
function set(id,r){var s=document.querySelector('#r-'+id+' .s');s.className='s '+(r.ok?'ok':'no');s.textContent=r.ok?('OK'+(r.ms!=null?' · '+r.ms+' ms':'')):'Failed'}
function timed(p,ms){return new Promise(function(res){var d=false;var to=setTimeout(function(){if(!d){d=true;res(false)}},ms);p.then(function(){if(!d){d=true;clearTimeout(to);res(true)}},function(){if(!d){d=true;clearTimeout(to);res(false)}})})}
row('page','Page opened');row('telegram','Opened inside Telegram');row('api','Pleat server (this address)');row('sdk','telegram.org script');
(CFG.others||[]).forEach(function(b,i){row('o'+i,b.replace('https://',''))});row('report','Result sent to admin');
set('page',R.page);set('telegram',R.telegram);
var a0=performance.now();var api=timed(fetch('/api/v1/ip',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0}),10000).then(function(ok){R.api={ok:ok,ms:Math.round(performance.now()-a0)};set('api',R.api)});
var s0=performance.now();var sdk=new Promise(function(res){var s=document.createElement('script');s.src='https://telegram.org/js/telegram-web-app.js';s.onload=function(){res(true)};s.onerror=function(){res(false)};document.head.appendChild(s);setTimeout(function(){res(false)},10000)}).then(function(ok){R.sdk={ok:ok,ms:Math.round(performance.now()-s0)};set('sdk',R.sdk);try{if(ok&&window.Telegram&&Telegram.WebApp){Telegram.WebApp.ready();Telegram.WebApp.expand()}}catch(e){}});
var oth=(CFG.others||[]).map(function(b,i){var o0=performance.now();return timed(fetch(b+'/health',{mode:'no-cors',cache:'no-store'}),10000).then(function(ok){var r={base:b,ok:ok,ms:Math.round(performance.now()-o0)};others[i]=r;set('o'+i,r)})});
Promise.all([api,sdk].concat(oth)).then(function(){
 if(!initData){set('report',{ok:false});note('Open this page from the Telegram bot to send the result.');return}
 fetch('/api/v1/mini/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({init_data:initData,origin:location.origin,platform:platform,steps:R,others:others})})
 .then(function(r){set('report',{ok:r.ok});note(r.ok?'Done. The result is in the bot.':'The result could not be sent. Use Copy report.')},function(){set('report',{ok:false});note('The result could not be sent. Use Copy report.')});
});
function note(t){document.getElementById('note').textContent=t}
function text(){var l=['Pleat Mini App test','address: '+location.host,'platform: '+(platform||'?')];document.querySelectorAll('#list li').forEach(function(li){l.push(li.firstChild.textContent+': '+li.lastChild.textContent)});return l.join('\\n')}
document.getElementById('copy').onclick=function(){var t=text();(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){note('Copied.')},function(){prompt('Copy:',t)})};
})();
</script></body></html>`;
