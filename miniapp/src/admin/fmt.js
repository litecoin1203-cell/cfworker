// Persian labels and number formats for the admin panel (numbers stay Latin, like the bot).
const GB = 1024 ** 3;
export const n = (v) => Number(v || 0).toLocaleString('en-US');
export const gb = (b) => (b == null ? '—' : (Number(b) / GB).toFixed(Number(b) >= 10 * GB ? 1 : 2));
export const day = (t) => (t ? new Date((typeof t === 'number' ? t * 1000 : t)).toISOString().slice(0, 10) : '—');
export function ago(t, now = Date.now() / 1000) {
  if (!t) return 'هرگز';
  const d = Math.max(0, now - t);
  if (d < 120) return 'الان آنلاین';
  if (d < 3600) return `${Math.floor(d / 60)} دقیقه پیش`;
  if (d < 86400) return `${Math.floor(d / 3600)} ساعت پیش`;
  return `${Math.floor(d / 86400)} روز پیش`;
}
export const METHOD = { card: 'کارت به کارت', coin: 'ارز دیجیتال', wallet: 'کیف پول', crypto: 'درگاه ارز', gateway: 'درگاه' };
export const STATUS = { pending: 'در انتظار پرداخت', review: 'منتظر بررسی', paid: 'پرداخت‌شده', rejected: 'ردشده', cancelled: 'لغوشده', expired: 'منقضی', settling: 'در حال فعال‌سازی' };
export const SUB = { active: 'فعال', expired: 'منقضی', limited: 'حجم تمام', disabled: 'متوقف', missing: 'در حال ساخت' };
export const PANEL_STATE = { active: 'روشن', limited: 'حجم پر', expired: 'منقضی', disabled: 'خاموش', on_hold: 'در انتظار', panel_off: 'پنل خارج شده', no_answer: 'پنل جواب نداد', missing: 'اکانت پیدا نشد' };
export const ROLE = { owner: 'مالک', support: 'پشتیبان', viewer: 'فقط مشاهده' };
