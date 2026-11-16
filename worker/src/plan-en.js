// English plan names and badges for Pleat and the Mini App (English only; release audit UX-03). The owner names
// plans in Persian in the bot, and the old app shows `name` / `badge` as they are, so those stay. Every client that
// is English reads name_en / badge_en / description_en instead:
// - name_en: the English name the owner set (plan card › 🔤 نام انگلیسی), else the plan's own name when it has no
//   Persian in it, else one made from the numbers ("1 month · 50 GB");
// - badge_en: the owner's English badge, else the badge when it has no Persian, else a known Persian badge in
//   English, else '' (no badge);
// - description_en: the description when it has no Persian, else ''.
// The owner's English texts live in one setting, plan_names_en = {"<plan id>": {"name": "...", "badge": "..."}}:
// no migration, one D1 read per request that shows plans.
import { getSetting, setSetting } from './db.js';

export const PLAN_EN_KEY = 'plan_names_en';
export const PERSIAN_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const EN_BADGES = { 'پیشنهاد ویژه': 'Recommended', 'محبوب': 'Popular', 'به‌صرفه‌ترین': 'Best value', 'پرفروش': 'Best seller', 'جدید': 'New' };
export const EN_MAX = 40;

export function parsePlanEn(raw) {
  try {
    const m = JSON.parse(raw || '{}');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch (e) { return {}; }
}
export const loadPlanEn = async (env) => parsePlanEn(await getSetting(env, PLAN_EN_KEY));

const own = (en, p, k) => {
  const v = en && en[p.id] && en[p.id][k];
  return typeof v === 'string' && v.trim() && !PERSIAN_RE.test(v) ? v.trim() : '';
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function autoName(p) {
  const d = parseInt(p.duration_days, 10) || 0;
  const time = d >= 365 && d % 365 === 0 ? plural(d / 365, 'year') : d >= 30 && d % 30 === 0 ? plural(d / 30, 'month') : plural(d, 'day');
  const gb = parseInt(p.data_limit_gb, 10) || 0;
  return `${time} · ${gb ? `${gb} GB` : 'Unlimited'}`;
}

export function planEnName(p, en = {}) {
  const set = own(en, p, 'name');
  if (set) return set;
  const n = String(p.name || '').trim();
  return n && !PERSIAN_RE.test(n) ? n : autoName(p);
}

export function planEnBadge(p, en = {}) {
  const set = own(en, p, 'badge');
  if (set) return set;
  const b = String(p.badge || '').trim();
  if (!b) return '';
  return PERSIAN_RE.test(b) ? EN_BADGES[b.replace(/\s+/g, ' ')] || '' : b;
}

export const planEnDescription = (p) => (PERSIAN_RE.test(p.description || '') ? '' : String(p.description || ''));

// the owner's own text (what the bot and the Mini App admin edit); '' = none, the fallback is used
export const planEnOwn = (en, id, k) => (en[id] && typeof en[id][k] === 'string' ? en[id][k] : '');

// sets (or with '' clears) the owner's English name or badge of one plan; returns the text it had
export async function setPlanEn(env, id, k, val) {
  const en = await loadPlanEn(env);
  const before = planEnOwn(en, id, k);
  const cur = { ...(en[id] || {}) };
  if (val) cur[k] = val; else delete cur[k];
  if (Object.keys(cur).length) en[id] = cur; else delete en[id];
  await setSetting(env, PLAN_EN_KEY, JSON.stringify(en));
  return before;
}
