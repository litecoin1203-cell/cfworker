// The admin actions are shared with the Persian admin bot, so their refusals come back in Persian. The panel is
// English: the ones below are translated exactly; a sentence that is not here keeps its English fallback with
// the original after it, so nothing the server said is lost. Tested in test/errors.test.js.
const EXACT = {
  'آیدی درست نیست.': 'That id is not right.',
  'آیدی عددی تلگرام درست نیست (۵ تا ۱۵ رقم).': 'The Telegram id must be 5 to 15 digits.',
  'اجازه‌ی این کار را نداری.': 'Your admin role cannot do this.',
  'این آیدی خود مالک است؛ مالک همیشه همه‌ی دسترسی‌ها را دارد.': 'That is the owner; the owner always has every right.',
  'این آیدی مدیر نیست.': 'That id is not an admin.',
  'این اشتراک قطع موقت نیست.': 'This subscription is not paused.',
  'این اشتراک همین الان فعال نیست.': 'This subscription is not active right now.',
  'این ایمیل همین الان برای حساب دیگری ثبت شد.': 'Another account just took this email.',
  'این ایمیل همین الان ثبت شد.': 'This email was just taken.',
  'این تغییر دیگر برگشت‌پذیر نیست (بیش از ۱۰ دقیقه گذشته یا قبلاً برگردانده شده).': 'This change can no longer be undone (over 10 minutes, or already undone).',
  'این دستگاه پیدا نشد.': 'Device not found.',
  'این سفارش شارژ کیف پول است؛ پولش همین الان در کیف پول کاربر است.': 'This order is a wallet top-up; the money is already in the user\'s wallet.',
  'این سفارش قبلاً به کیف پول برگردانده شده است.': 'This order was already refunded to the wallet.',
  'این سفارش قبلاً تأیید و فعال شده است.': 'This order was already approved and activated.',
  'این سفارش مبلغی ندارد که برگردد.': 'This order has no amount to refund.',
  'این سفارش پرداخت و فعال شده؛ رد نمی‌شود. برای پس دادن پول «↩️ بازگشت به کیف پول» را بزن.': 'This order is paid and active, so it cannot be rejected. Use "Refund to wallet" to give the money back.',
  'این لیست در این فاصله عوض شده؛ دوباره نگاه کن.': 'The list changed meanwhile. Look again.',
  'این مورد دیگر در لیست نیست.': 'That item is no longer in the list.',
  'این مورد همین الان در لیست هست.': 'That item is already in the list.',
  'این پلن بایگانی است؛ اول «📤 برگرداندن از بایگانی» را بزن.': 'This plan is archived. Restore it first.',
  'این پلن بایگانی نیست.': 'This plan is not archived.',
  'این پلن قبلاً بایگانی شده است.': 'This plan is already archived.',
  'این پلن پیدا نشد یا بایگانی است.': 'Plan not found, or archived.',
  'این پیام در حال ارسال نیست.': 'This broadcast is not sending.',
  'این پیام قبلاً شروع یا لغو شده است.': 'This broadcast was already started or cancelled.',
  'این پیام پیدا نشد.': 'Broadcast not found.',
  'این کاربر آواتار انتخاب نکرده است.': 'This user has not chosen an avatar.',
  'این کاربر اشتراک ندارد. اول از «🎁 دادن پلن» برایش پلن بگذار.': 'This user has no subscription. Give a plan first.',
  'این کاربر تلگرام وصل‌شده ندارد.': 'This user has no Telegram linked.',
  'این کاربر حذف شده است.': 'This user is deleted.',
  'این کاربر قبلاً حذف شده است.': 'This user is already deleted.',
  'این کد پیدا نشد.': 'Code not found.',
  'برگرداندن ممکن نشد (مثلاً این مورد در این فاصله استفاده شده است).': 'Could not undo (it may have been used meanwhile).',
  'تعداد باید 0 (نامحدود) یا بیشتر باشد.': 'Uses must be 0 (no limit) or more.',
  'تعداد روز باید بین 1 و 3650 باشد.': 'Days must be between 1 and 3650.',
  'جابه‌جایی ممکن نیست.': 'It cannot move further.',
  'حجم این اشتراک نامحدود است.': 'This subscription has unlimited data.',
  'حجم باید بین 1 و 100000 گیگ باشد.': 'Data must be between 1 and 100000 GB.',
  'درصد باید بین 1 و 100 باشد.': 'Percent must be between 1 and 100.',
  'دلیل (یادداشت) لازم است.': 'A note (the reason) is needed.',
  'رمز درست نیست.': 'The password is not right.',
  'روز باید بین 0 (همیشه) و 3650 باشد.': 'Days must be between 0 (no end) and 3650.',
  'زمان این اشتراک نامحدود است.': 'This subscription has no end date.',
  'سرور پیدا نشد.': 'Server not found.',
  'سفارش پیدا نشد.': 'Order not found.',
  'شکل درست: /reset email@example.com رمزجدید (حداقل ۸ کاراکتر)': 'The password must be at least 8 characters.',
  'شکل درست: /rollout شماره درصد (0 تا 100)': 'The share must be 0 to 100 percent.',
  'شکل درست: نام|روز|گیگ|دستگاه|قیمت': 'Give a name, the days and a price.',
  'فقط سفارش پرداخت‌شده به کیف پول برمی‌گردد.': 'Only a paid order can be refunded to the wallet.',
  'فقط پنل غیرفعال دوباره فعال می‌شود.': 'Only a disabled panel can be enabled again.',
  'فیلد ناشناخته.': 'Unknown field.',
  'لیست ناشناخته.': 'Unknown list.',
  'مالک حذف نمی‌شود.': 'The owner cannot be removed.',
  'مبلغ درست نیست.': 'The amount is not right.',
  'مسدود نیست.': 'Not blocked.',
  'نام سرور باید ۱ تا ۴۰ حرف انگلیسی، عدد یا ایموجی باشد (اپ انگلیسی است؛ حرف فارسی و # " < > قبول نمی‌شود).': 'A server name is 1 to 40 English letters, digits or emoji (the app is English; no Persian and no # " < >).',
  'نام پنل باید ۱ تا ۴۰ حرف باشد.': 'A panel name is 1 to 40 characters.',
  'نقش درست نیست.': 'Unknown role.',
  'هدف پاک کردن درست نیست.': 'Nothing to clear there.',
  'همین الان مسدود است.': 'Already blocked.',
  'وضعیت سفارش همین الان عوض شد؛ دوباره نگاه کن.': 'The order changed meanwhile. Look again.',
  'پلن درست نیست.': 'Unknown plan.',
  'پلن پیدا نشد.': 'Plan not found.',
  'پنل پیدا نشد': 'Panel not found.',
  'پنل پیدا نشد.': 'Panel not found.',
  'کار ناشناخته.': 'Unknown action.',
  'کاربر این سفارش پیدا نشد.': 'The user of this order was not found.',
  'کاربر پیدا نشد.': 'User not found.',
  'کاربر یا پلن پیدا نشد': 'User or plan not found.',
  'کاربری با این ایمیل نیست.': 'No user has this email.',
  'گیرنده‌ها درست نیست.': 'Unknown audience.',
  'یک پیام همگانی دیگر در حال ارسال است؛ اول آن تمام یا متوقف شود.': 'Another broadcast is sending. Let it finish or stop it first.',
  '❌ اطلاعیه حداکثر ۱۰۰۰ حرف است.': 'The announcement is at most 1000 characters.',
  '❌ این شماره کارت درست نیست (۱۶ رقم و معتبر). دوباره از روی کارت بنویس.': 'That card number is not valid (16 digits). Type it again from the card.',
  '❌ حجم تست را به گیگ و فقط عدد بنویس (0 = مثل پلن).': 'Trial data is a whole number of GB (0 = same as the plan).',
  '❌ لینک پشتیبانی باید با https:// یا tg:// شروع شود، مثلاً https://t.me/your_support': 'The support link must start with https:// or tg://, for example https://t.me/your_support',
  '❌ آدرس درست نیست. فقط https و نام دامنه، مثل https://api.example.com (بدون مسیر).': 'Not a valid address. https and a domain only, like https://api.example.com (no path).',
  '❌ کانفیگ درست نیست. باید با vless:// یا vmess:// یا trojan:// یا ss:// یا hysteria2:// یا wireguard:// شروع شود.': 'Not a valid config. It must start with vless://, vmess://, trojan://, ss://, hysteria2:// or wireguard://.',
  'این کد قبلاً ساخته شده.': 'This code already exists.',
  'انجام نشد.': 'It did not work.',
  'برگشت ممکن نشد.': 'Could not undo.',
};

const PATTERNS = [
  [/^حداکثر (\d+) مورد/, (m) => `At most ${m[1]} items. Remove one first.`],
  [/^متن باید ۱ تا ([\d,]+) حرف باشد/, (m) => `The text must be 1 to ${m[1]} characters.`],
  [/^وضعیت این سفارش «(\w+)» است و تأیید نمی‌شود/, (m) => `This order is ${m[1]}, so it cannot be approved.`],
  [/^وضعیت این سفارش «(\w+)» است/, (m) => `This order is ${m[1]}.`],
  [/^کلید ناشناخته/, () => 'Unknown setting.'],
  [/^❌ این آدرس برای (.+?) درست به نظر نمی‌رسد/, (m) => `That address does not look right for ${m[1]}. Copy it again from your wallet.`],
  [/^❌ موجودی کافی نیست \(موجودی: ([\d,]+) تومان\)/, (m) => `Not enough balance (${m[1]} toman). A wallet never goes below zero.`],
  [/^❌ Destination Tag ریپل فقط عدد است/, () => 'An XRP Destination Tag is digits only (at most 10).'],
  [/^❌ این Memo طولانی‌تر از حد مجاز است/, () => 'That memo is too long.'],
  [/^این کد قبلاً ساخته شده/, () => 'This code already exists.'],
  [/^اول پنل را تست کن/, () => 'Test the panel first.'],
  [/^تعداد درخواست‌ها زیاد است/, () => 'Too many requests. Wait a minute and try again.'],
  [/^فیلد ناشناخته/, () => 'Unknown field.'],
  [/^شکل درست: \/coupon/, () => 'Fill in the code and the percent.'],
  [/^همین الان اولین پلن است/, () => 'This is already the first plan.'],
  [/^همین الان آخرین پلن است/, () => 'This is already the last plan.'],
  // a failure that carries the panel's or the billing code's own reason after a colon
  [/^⚠️ وصل نشد:\s*([\s\S]*)$/, (m) => `Could not link: ${inner(m[1])}`],
  [/^⚠️ فعال نشد:\s*([\s\S]*)$/, (m) => `Could not activate: ${inner(m[1])}`],
];

const inner = (t) => {
  t = String(t || '').trim();
  if (t === 'این اکانت پنل همین الان به کاربر دیگری وصل شد.') return 'that panel account was just linked to another user.';
  if (t === 'خطای ناشناخته') return 'unknown error.';
  return EXACT[t] || t;
};

const PERSIAN = /[؀-ۿ]/;

export function englishError(msg) {
  const t = String(msg || '').trim();
  if (!t) return 'It did not work.';
  if (!PERSIAN.test(t)) return t;
  if (EXACT[t]) return EXACT[t];
  for (const [re, fn] of PATTERNS) { const m = re.exec(t); if (m) return fn(m); }
  return `It did not work: ${t}`;
}

export const _known = () => Object.keys(EXACT).length + PATTERNS.length;
