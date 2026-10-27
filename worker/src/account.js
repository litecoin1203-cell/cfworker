// Public config, plans, profile, the VPN subscription (live from the panel), servers, devices and the free trial.
import { first, all, run, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec } from './util.js';
import { PasarGuard, PasarGuardError, pgOrThrow } from './pasarguard.js';
import { provision, parseExpire } from './billing.js';
import { cryptoEnabled } from './nowpayments.js';
import { notifyAdmin } from './telegram.js';

export async function appConfig(env) {
  const s = await getSettings(env);
  return json({
    support_url: s.support_url,
    announcement: s.announcement,
    card_enabled: !!s.card_number,
    crypto_enabled: cryptoEnabled(env) && parseInt(s.usdt_rate_toman, 10) > 0,
    min_topup_toman: parseInt(s.min_topup_toman, 10) || 0,
    referral_percent: parseInt(s.referral_percent, 10) || 0,
  });
}

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

// Subscription as the app shows it. Usage, limit, expiry and status come live from the panel.
export async function subscriptionOut(env, user, live = true) {
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  if (!sub) return null;
  const plan = sub.plan_id ? await first(env, 'SELECT * FROM plans WHERE id = ?', sub.plan_id) : null;
  let status = 'active', used = 0, expires = sub.expires_at, dataLimit = sub.data_limit_bytes, liveOk = false, onlineAt = null;
  if (live && env.PASARGUARD_URL) {
    try {
      const pgUser = await new PasarGuard(env).getUser(sub.pg_username);
      if (!pgUser) status = 'missing';
      else {
        liveOk = true;
        status = pgUser.status || 'active';
        used = parseInt(pgUser.used_traffic || 0, 10) || 0;
        dataLimit = parseInt(pgUser.data_limit || 0, 10) || 0;
        const exp = parseExpire(pgUser.expire);
        expires = exp || null;
        onlineAt = pgUser.online_at || null;
        // keep our copy in step so /find and the trial checks stay right even when the panel is slow later
        if (exp !== sub.expires_at || dataLimit !== sub.data_limit_bytes) {
          await run(env, 'UPDATE subscriptions SET expires_at = ?, data_limit_bytes = ?, updated_at = ? WHERE id = ?', exp, dataLimit, nowSec(), sub.id);
        }
      }
    } catch (e) { status = 'unknown'; }
  }
  const now = nowSec();
  if (expires && expires < now && ['active', 'unknown'].includes(status)) status = 'expired';
  if (dataLimit && used >= dataLimit && status === 'active') status = 'limited';
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400)) : null;
  const usable = status === 'active' || status === 'unknown' || status === 'on_hold';
  return {
    active: usable, status, live: liveOk, plan_name: plan ? faName(plan.name) : null,
    expires_at: expires ? new Date(expires * 1000).toISOString() : null, days_left: daysLeft,
    seconds_left: expires ? Math.max(0, expires - now) : null,
    unlimited_time: !expires, unlimited_data: !dataLimit,
    data_limit_bytes: dataLimit, used_bytes: used, remaining_bytes: dataLimit ? Math.max(0, dataLimit - used) : null,
    device_limit: sub.device_limit, online_at: onlineAt, period_days: sub.period_days || (plan ? plan.duration_days : null),
    sub_url: status === 'missing' ? '' : sub.sub_url,
  };
}

async function trialAvailable(env, user) {
  if (user.trial_used) return false;
  const has = await first(env, 'SELECT id FROM subscriptions WHERE user_id = ?', user.id);
  return !has;
}

export async function me(env, user) {
  return json({
    id: user.id, email: user.email, wallet_balance: user.wallet_balance, referral_code: user.referral_code,
    created_at: new Date(user.created_at * 1000).toISOString(),
    trial_available: await trialAvailable(env, user),
    subscription: await subscriptionOut(env, user),
  });
}

export function myIp(env, request) {
  return json({ ip: request.headers.get('cf-connecting-ip') || '' });
}

// ---------------- VPN ----------------
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
function flagToCc(text) {
  const m = (text || '').match(FLAG_RE);
  if (!m) return '';
  return Array.from(m[0]).map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join('');
}
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
  const clean = name.replace(FLAG_RE, '').replace(/^[\s\-|·]+|[\s\-|·]+$/g, '');
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
  const out = await subscriptionOut(env, user);
  if (out.status === 'missing') throw err(410, 'sub_missing', 'اکانت شما روی سرور پیدا نشد. با پشتیبانی تماس بگیر.');
  return json({ subscription: out, remarks: 'Cloud Gold' });
}

// The subscription body, fetched by the Worker. The app uses this when the panel address is filtered on the
// phone's network: Cloudflare can still reach the panel. The phone's HWID headers are passed through.
export async function vpnSub(env, user, request) {
  const sub = await activeSub(env, user);
  const H = request.headers;
  await checkDevice(env, user, sub, H.get('x-device-id'), H.get('x-device-model'));
  if (!sub.sub_url) throw err(404, 'no_servers', 'برای اشتراک شما هنوز سروری تعریف نشده است.');
  let raw;
  try {
    raw = await pgOrThrow(env).subscriptionRaw(sub.sub_url, {
      'x-hwid': H.get('x-hwid'), 'x-device-os': H.get('x-device-os'), 'x-ver-os': H.get('x-ver-os'), 'x-device-model': H.get('x-device-model'),
    });
  } catch (e) {
    if (e instanceof PasarGuardError) throw err(503, 'panel_unavailable', 'الان به سرورها دسترسی نداریم. چند دقیقه دیگر دوباره امتحان کن.');
    throw e;
  }
  if (raw.status === 403 || raw.status === 429) throw err(403, 'device_limit', 'این اشتراک روی حداکثر تعداد گوشی استفاده شده است.');
  if (raw.status === 404) throw err(410, 'sub_missing', 'اکانت شما روی سرور پیدا نشد. با پشتیبانی تماس بگیر.');
  if (raw.status < 200 || raw.status >= 300) throw err(503, 'panel_unavailable', `سرورها الان در دسترس نیستند (${raw.status}).`);
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (raw.userinfo) headers['subscription-userinfo'] = raw.userinfo;
  return new Response(raw.text, { status: 200, headers });
}

export async function vpnServers(env, user) {
  const sub = await activeSub(env, user);
  let links;
  try { links = await pgOrThrow(env).subscriptionLinks(sub.sub_url); }
  catch (e) { throw err(503, 'panel_unavailable', `سرورها الان در دسترس نیستند (${e.status || 'network'}).`); }
  return json(links.map((link, i) => parseLink(i, link)));
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
  try {
    await provision(env, user, plan, { days: plan.trial_days, dataGb: trialGb > 0 ? trialGb : undefined });
  } catch (e) {
    if (e instanceof PasarGuardError) {
      await notifyAdmin(env, `⚠️ تست رایگان برای ${user.email} ساخته نشد.\n\nخطای پنل:\n${e.message}\n\nبرای عیب‌یابی /panel را بزن.`);
      throw err(503, 'provision_failed', 'فعال‌سازی تست رایگان الان ممکن نشد. پشتیبانی خبردار شد؛ چند دقیقه دیگر دوباره امتحان کن.');
    }
    throw e;
  }
  await run(env, 'UPDATE users SET trial_used = 1 WHERE id = ?', user.id);
  if (deviceId) {
    const d = await first(env, 'SELECT id FROM devices WHERE user_id = ? AND device_id = ?', user.id, deviceId);
    if (!d) await run(env, 'INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?,?,?,?)', user.id, deviceId, request.headers.get('x-device-model') || '', nowSec());
  }
  await notifyAdmin(env, `🎁 تست رایگان: ${user.email} (${plan.trial_days} روز از ${faName(plan.name)}${trialGb > 0 ? `، ${trialGb} گیگ` : ''})`);
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return me(env, fresh);
}
