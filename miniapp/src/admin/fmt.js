// English labels and number formats for the admin panel. Pure functions, unit-tested in test/admin.test.js.
const GB = 1024 ** 3;
export const n = (v) => Math.round(Number(v || 0)).toLocaleString('en-US');
export function gb(b) {
  if (b == null) return '—';
  const v = Math.max(0, Number(b) || 0) / GB;
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}
// 1,890,000 -> "1.89M", 250,000 -> "250K"
export function short(v) {
  const x = Math.round(Number(v || 0));
  if (Math.abs(x) >= 1e6) return (Math.round(x / 1e4) / 100).toString() + 'M';
  if (Math.abs(x) >= 1e4) return Math.round(x / 1e3) + 'K';
  return n(x);
}
const ts = (t) => (typeof t === 'number' ? t * 1000 : Date.parse(t));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function day(t) {
  if (!t) return '—';
  const d = new Date(ts(t));
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export function dayShort(t) {
  if (!t) return '—';
  const d = new Date(ts(t));
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function ago(t, now = Date.now() / 1000) {
  if (!t) return 'never';
  const d = Math.max(0, now - (typeof t === 'number' ? t : ts(t) / 1000));
  if (d < 120) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 30 * 86400) return `${Math.floor(d / 86400)} d ago`;
  return day(t);
}
export const plural = (k, one, many) => `${n(k)} ${Number(k) === 1 ? one : many || one + 's'}`;

export const METHOD = { card: 'Card to card', coin: 'Crypto', wallet: 'Wallet', crypto: 'Crypto gateway', gateway: 'Gateway' };
export const STATUS = { pending: 'Awaiting payment', review: 'To review', paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired', settling: 'Activating' };
export const STATUS_TONE = { pending: '', review: 'info', paid: 'ok', rejected: 'bad', cancelled: '', expired: '', settling: 'warn' };
export const PANEL_STATE = { new: 'New', testing: 'Tested', rollout: 'Rolling out', active: 'Active', draining: 'Leaving', disabled: 'Disabled' };
export const PANEL_TONE = { new: '', testing: 'info', rollout: 'warn', active: 'ok', draining: 'warn', disabled: 'bad' };
export const ACCOUNT_STATE = { active: 'On', limited: 'Data full', expired: 'Expired', disabled: 'Off', on_hold: 'On hold', panel_off: 'Panel removed', no_answer: 'No answer', missing: 'Not on panel' };
export const ROLE = { owner: 'Owner', support: 'Support', viewer: 'Viewer' };
export const AUDIENCE = { all: 'Everyone on Telegram', active: 'Active plan', expired: 'Plan ended', none: 'No plan' };
export const BC_STATUS = { draft: 'Draft', sending: 'Sending', done: 'Done', stopped: 'Stopped' };
export const SMS_RESULT = { paid: 'Confirmed', review: 'Sent to you', no_order: 'No order with this amount', ambiguous: 'Several orders match', settle_failed: 'Found, not activated', not_deposit: 'Not a deposit', duplicate: 'Duplicate', untrusted: 'Unknown sender' };
export const TX_REASON = { admin_credit: 'Admin credit', admin_debit: 'Admin debit', referral: 'Referral reward', topup: 'Top-up', purchase: 'Purchase', refund: 'Refund', admin_refund: 'Order refund' };
export const AUTO = { auto: 'Automatic', detect: 'Ask me', off: 'Off' };
export const NET_KIND = { wifi: 'Wi-Fi', cell: 'Mobile data', other: 'Other network', '': 'Unknown' };
export const GOOGLE = { google: 'Google and Gemini fine', no_gemini: 'Google fine, Gemini not', iran: 'Google sees it as Iran', flagged: 'Google flags the IP (captcha)' };
export const GOOGLE_TONE = { google: 'ok', no_gemini: 'warn', iran: 'bad', flagged: 'bad' };
export const STOP = { quota: 'Data used up', expired: 'Time ended', admin: 'Paused by admin' };

export function subState(sub, now = Date.now() / 1000) {
  if (!sub) return { label: 'No plan', tone: '' };
  if (sub.paused) return { label: 'Paused', tone: 'warn' };
  if (sub.active) return { label: 'Active', tone: 'ok' };
  if (sub.expires_at && sub.expires_at <= now) return { label: 'Ended', tone: 'bad' };
  return { label: STOP[sub.stop_reason] || 'Stopped', tone: 'bad' };
}

// how many of `total` pleats are still full; any data left shows at least one
export function pleatsLeft(used, limit, total = 12) {
  if (!limit) return total;
  const left = Math.max(0, limit - (used || 0)) / limit;
  return left <= 0 ? 0 : Math.max(1, Math.min(total, Math.ceil(left * total)));
}

// what an audit row's action means, in a few words
const ACTION = {
  'plan.set': 'Plan edited', 'plan.toggle': 'Plan on/off', 'plan.create': 'Plan created', 'plan.move': 'Plan moved', 'plan.copy': 'Plan copied', 'plan.delete': 'Plan removed', 'plan.unarchive': 'Plan restored',
  'setting.set': 'Setting changed', 'coupon.create': 'Code created', 'coupon.delete': 'Code deleted', 'coupon.set': 'Code edited', 'coupon.toggle': 'Code on/off',
  'panel.rollout': 'Panel share', 'panel.groups': 'Panel groups', 'panel.drain': 'Panel removed', 'panel.rename': 'Panel renamed', 'panel.enable': 'Panel enabled',
  'panel.add': 'Panel added', 'panel.cred': 'Panel login changed', 'panel.test': 'Panel tested',
  'health.resolve': 'App problem resolved / reopened', 'health.mute': 'App problem muted', 'health.mode': 'App health reports mode',
  'user.grant': 'Plan given', 'user.link': 'Panel account linked', 'user.reset_password': 'Password changed', 'user.add_days': 'Days added', 'user.add_gb': 'Data added',
  'user.reset_usage': 'Usage reset', 'user.pause': 'Pause / resume', 'user.end': 'Subscription ended', 'user.plan_name': 'Plan name changed', 'user.wallet': 'Wallet changed',
  'user.device_remove': 'Device removed', 'user.logout_all': 'Signed out everywhere', 'user.block': 'Block / unblock', 'user.unlink_tg': 'Telegram unlinked', 'user.unlink_panel': 'Panel account unlinked',
  'user.avatar_reset': 'Avatar reset', 'user.email': 'Email changed', 'user.delete': 'User deleted', 'user.create': 'User created',
  'order.approve': 'Order approved', 'order.reject': 'Order rejected', 'order.cancel': 'Order cancelled', 'order.refund': 'Order refunded',
  'server.hide': 'Server shown / hidden', 'server.rename': 'Server renamed', 'app.list': 'App list changed', 'app.release': 'App release', 'net.reset': 'Network stats cleared',
  'broadcast.create': 'Broadcast drafted', 'broadcast.start': 'Broadcast started', 'broadcast.stop': 'Broadcast stopped', 'admin.add': 'Admin added', 'admin.remove': 'Admin removed',
  'system.backup': 'Backup sent',
};
export const actionLabel = (a) => (ACTION[a] || (String(a).endsWith('.undo') ? `Undone: ${ACTION[String(a).slice(0, -5)] || a.slice(0, -5)}` : a));

// labels for every setting key
export const SETTING = {
  card_number: 'Card number', card_holder: 'Card holder', card_bank: 'Bank', usdt_rate_toman: 'Tether price (old)', referral_percent: 'Referral reward %',
  pg_group_ids: 'Panel groups', support_url: 'Support link', min_topup_toman: 'Minimum top-up', announcement: 'App announcement', app_api_bases: 'App domains',
  app_bridges: 'App bridges', trial_data_gb: 'Trial data (GB, 0 = as plan)', trial_needs_telegram: 'Trial needs verified Telegram', usd_rate_toman: 'Manual dollar price (0 = auto)',
  coin_minutes: 'Crypto payment time (min)', card_unique: 'Unique card amount (1 on, 0 off)', card_auto: 'Card SMS confirm', sms_senders: 'Trusted bank senders',
  sms_key: 'SMS address key', coin_auto: 'Crypto confirm',
};

// a setting's name; the crypto wallets are one key per coin (wallet_usdt_trc20, wallet_xlm_memo, ...)
export function settingLabel(k) {
  if (SETTING[k]) return SETTING[k];
  if (k.startsWith('wallet_')) {
    const memo = k.endsWith('_memo');
    return `${k.slice(7, memo ? -5 : undefined).replace(/_/g, ' ').toUpperCase()} wallet ${memo ? 'memo / tag' : 'address'}`;
  }
  return k;
}

// The admin log's summaries are written by the shared bot code in Persian. The common words are put into English;
// a part that still holds Persian after that is left out rather than shown half translated.
const SUM = [
  ['همه‌ی کاربران تلگرام', 'everyone on Telegram'], ['اشتراک تمام‌شده', 'plan ended'], ['اشتراک فعال', 'active plan'], ['بدون پلن', 'no plan'],
  ['(جمع با اشتراک فعلی)', '(added to the current plan)'], ['خروج از همه‌ی دستگاه‌ها', 'signed out everywhere'], ['پایان اشتراک', 'subscription ended'],
  ['انقضای قبلی', 'was until'], ['انقضا', 'ends'], ['قطع موقت', 'paused'], ['وصل دوباره', 'resumed'], ['مسدود', 'blocked'], ['آزاد', 'unblocked'],
  ['جداکردن تلگرام', 'Telegram unlinked'], ['حذف دستگاه', 'removed device'], ['کاربر دستی', 'made by hand:'], ['تأیید دستی', 'approved by hand'],
  ['به کیف پول', 'to wallet'], ['خارج‌سازی', 'drain'], ['بایگانی', 'archived'], ['کپی از', 'copy of'], ['پیش‌فرض', 'default'], ['آواتار', 'avatar'],
  ['(پیش‌نویس)', '(draft)'], ['اجباری', 'mandatory'], ['(خودکار)', '(auto)'], ['حذف شد', 'removed'], ['برگشت', 'undo of'], ['حذف', 'deleted'],
  ['نامحدود', 'unlimited'], ['مصرف', 'usage'], ['سقف', 'cap'], ['پنل', 'panel'], ['پلن', 'plan'], ['روز', 'days'], ['گیگ', 'GB'], ['حرف', 'chars'],
  ['حدود', 'about'], ['نفر', 'people'], ['بار', 'uses'], ['همه', 'all'], ['جای', 'place'], ['ردیف از', 'rows from'], ['مالک', 'owner'],
  ['پشتیبان', 'support'], ['فقط دیدن', 'viewer'], [' ت', ' toman'], ['←', '→'],
];
export function englishSummary(s) {
  let t = String(s || '');
  if (!/[؀-ۿ]/.test(t)) return t;
  for (const [fa, en] of SUM) t = t.split(fa).join(en);
  return t.split(' · ').filter((part) => !/[؀-ۿ]/.test(part)).join(' · ');
}
