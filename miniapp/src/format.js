// Pure helpers (unit-tested in test/format.test.js).
const GB = 1024 ** 3;

// "12.4" for bytes, one decimal under 100 GB, whole numbers above
export function gb(bytes) {
  const v = Math.max(0, Number(bytes) || 0) / GB;
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

export const money = (toman) => Math.max(0, Math.round(Number(toman) || 0)).toLocaleString('en-US');

// what the status chip says, and whether it is good news
export function statusOf(sub) {
  if (!sub) return { label: 'No plan', tone: 'muted' };
  switch (sub.status) {
    case 'active': return { label: 'Active', tone: 'safe' };
    case 'expired': return { label: 'Expired', tone: 'alert' };
    case 'limited': return { label: 'Data used up', tone: 'alert' };
    case 'missing': return { label: 'Being set up', tone: 'muted' };
    default: return { label: 'Paused', tone: 'alert' };
  }
}

// how many of the 10 pleats are still "full" (data left), rounded up so any data left shows at least one
export function pleatsLeft(sub, total = 10) {
  if (!sub || sub.unlimited_data || !sub.data_limit_bytes) return total;
  const left = Math.max(0, sub.data_limit_bytes - (sub.used_bytes || 0)) / sub.data_limit_bytes;
  return left <= 0 ? 0 : Math.max(1, Math.min(total, Math.ceil(left * total)));
}

// day dots: {total, left}, at most 31 dots (a long plan shows the last month)
export function dayDots(sub) {
  if (!sub || sub.unlimited_time || sub.days_left == null) return null;
  const period = Math.max(sub.period_days || 0, sub.days_left);
  const total = Math.min(31, Math.max(1, period));
  return { total, left: Math.min(total, sub.days_left) };
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 24);
}
