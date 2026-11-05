// Public config, plans, profile, the VPN subscription (from the control plane), the unified server list, devices and the free trial.
import { first, all, run, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec } from './util.js';
import { PasarGuard, PasarGuardError } from './pasarguard.js';
import { provision } from './billing.js';
import { collectLinks, flagToCc } from './panels.js';
import { refreshUser, usedBytes, ensureMissingFor } from './sync.js';
import { cryptoEnabled } from './nowpayments.js';
import { enabledCoins, coinOut } from './coins.js';
import { notifyAdmin } from './telegram.js';

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
  const rows = await all(env, 'SELECT * FROM plans WHERE is_active = 1 ORDER BY sort, id');
  return json(rows.map(planOut));
}

// Subscription as the app shows it. The control plane decides; with live = true every panel of the user is read
// first (so the numbers are fresh and a stop on quota happens right away). Nothing here names a panel.
// withSubUrl: only app versions before 1.9.0 still get the panel link (they download from it themselves).
export async function subscriptionOut(env, user, live = true, { withSubUrl = false } = {}) {
  let sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  if (!sub) return null;
  let liveOk = false, missing = false;
  if (live) {
    try {
      const r = await refreshUser(env, user.id);
      liveOk = r.reached > 0;
      missing = r.accounts > 0 && r.missing === r.accounts;
    } catch (e) { /* stale numbers are still right numbers */ }
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

export async function me(env, user, request) {
  return json({
    id: user.id, email: user.tg_id ? '' : user.email, login: user.tg_id ? (user.tg_username ? '@' + user.tg_username : String(user.tg_id)) : user.email,
    telegram: user.tg_id ? { id: String(user.tg_id), username: user.tg_username || null, name: user.tg_name || '' } : null,
    wallet_balance: user.wallet_balance, referral_code: user.referral_code,
    created_at: new Date(user.created_at * 1000).toISOString(),
    trial_available: await trialAvailable(env, user),
    subscription: await subscriptionOut(env, user, true, { withSubUrl: !centralApp(request) }),
  });
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
  const cc = flagToCc(name);
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
  if (!dev) await run(env, 'INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?,?,?,?)', user.id, deviceId, model || '', nowSec());
  else await run(env, 'UPDATE devices SET last_seen = ? WHERE id = ?', nowSec(), dev.id);
}

export async function vpn(env, user, request) {
  const sub = await activeSub(env, user);
  await checkDevice(env, user, sub, request.headers.get('x-device-id'), request.headers.get('x-device-model'));
  const out = await subscriptionOut(env, user, true, { withSubUrl: !centralApp(request) });
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
  const list = r.links.map((link, i) => parseLink(i, link));
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
  if (!plan || !plan.is_active || plan.trial_days <= 0) throw err(400, 'no_trial', 'این پلن تست رایگان ندارد.');
  if (!(await trialAvailable(env, user))) throw err(400, 'trial_used', 'تست رایگان را قبلاً استفاده کرده‌ای.');
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
    await provision(env, user, plan, { days: plan.trial_days, dataGb: trialGb > 0 ? trialGb : undefined });
  } catch (e) {
    await run(env, 'UPDATE users SET trial_used = 0 WHERE id = ?', user.id); // not built: the trial is still theirs
    if (e instanceof PasarGuardError) {
      await notifyAdmin(env, `⚠️ تست رایگان برای ${user.email} ساخته نشد.\n\nخطای پنل:\n${e.message}\n\nبرای عیب‌یابی /panel را بزن.`);
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
