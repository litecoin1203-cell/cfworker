// Thin helpers over the D1 binding (env.DB) plus the settings store.
import { nowSec } from './util.js';

export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

export async function insert(env, table, obj) {
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const r = await env.DB.prepare(sql).bind(...keys.map((k) => obj[k])).run();
  return r.meta.last_row_id;
}

// ---------------- settings ----------------
export const SETTING_DEFAULTS = {
  card_number: '',
  card_holder: '',
  card_bank: '',
  usdt_rate_toman: '0',
  referral_percent: '10',
  pg_group_ids: '',
  support_url: '',
  min_topup_toman: '50000',
  announcement: '',
  // the app's extra Worker addresses (https://..., space or comma separated): a new domain reaches every installed
  // app on its next launch, no new APK needed
  app_api_bases: '',
  // share links (vless://... etc.) the app may use as a "bridge" to reach the Worker when the open line can't,
  // for a phone with no plan yet; only the Worker's own addresses can cross it (enforced in the app)
  app_bridges: '',
  trial_data_gb: '0',
  // 1 = the free trial only for an account with a verified Telegram (one per Telegram account; new emails cost
  // nothing to make). 0 = any account, as before. Chosen by Ali 2026-11-08.
  trial_needs_telegram: '1',
  // Cloud Gold Pay: dollar price in toman + your own wallet address per coin (empty = coin hidden)
  usd_rate_toman: '0',
  coin_minutes: '30',
  // card-to-card: unique amount per order, and confirmation from the bank's deposit SMS
  card_unique: '1',
  card_auto: 'auto',   // auto = activate on a trusted bank SMS, detect = ask the admin, off = receipts only
  sms_senders: '',
  sms_key: '',         // secret part of the SMS webhook URL (created by /sms)     // trusted bank SMS senders, comma separated (set from the bot)
  coin_auto: 'auto',  // auto = activate by itself, detect = flag for one-tap approval, off = manual only
  wallet_xlm: '',
  wallet_xlm_memo: '',
  wallet_xrp: '',
  wallet_xrp_memo: '',
  wallet_trx: '',
  wallet_sol: '',
  wallet_ton: '',
  wallet_ton_memo: '',
  wallet_ltc: '',
  wallet_doge: '',
  wallet_bch: '',
  wallet_bnb: '',
  wallet_pol: '',
  wallet_algo: '',
  // PAY-08: one on/off switch per payment method (1 = offered, 0 = off; bot › 💳 روش‌های پرداخت, Mini App › Payment
  // methods). A method still needs its own setup to be offered (card number, a wallet address, the NOWPayments key and
  // usdt_rate_toman). Default 1, so a method that is set up keeps working as before. createOrder refuses an off method.
  pay_wallet_on: '1',  // buying a plan from the wallet balance (also "wallet + pay the rest")
  pay_card_on: '1',    // card to card
  pay_coin_on: '1',    // crypto to the admin's own wallets, all coins
  pay_coins_off: '',   // coins switched off one by one (ids, comma separated); their addresses stay saved
  pay_crypto_on: '1',  // the NOWPayments gateway
  // the admin bot's hourly Cloudflare alerts (cfmon.js): 1 = on, 0 = off
  cf_alerts: '1',
};

// PAY-08: a method's switch (anything but '0' is on) and the coins switched off one by one
export const switchOn = (s, key) => String(s[key] ?? '1').trim() !== '0';
export const coinsOff = (s) => String(s.pay_coins_off || '').toLowerCase().split(/[\s,]+/).filter(Boolean);

export async function getSettings(env) {
  const rows = await all(env, 'SELECT key, value FROM settings');
  const map = { ...SETTING_DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}
export async function getSetting(env, key) {
  const row = await first(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : (SETTING_DEFAULTS[key] ?? '');
}
export async function getSettingInt(env, key) {
  return parseInt(await getSetting(env, key), 10) || 0;
}
export async function setSetting(env, key, value) {
  await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}

export async function touchDevice(env, userId, deviceId, model) {
  if (!deviceId) return;
  // one statement: two sign-ins from the same phone at once no longer hit the UNIQUE index (a 500)
  await run(env, `INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen = excluded.last_seen`, userId, deviceId, model || '', nowSec());
}
