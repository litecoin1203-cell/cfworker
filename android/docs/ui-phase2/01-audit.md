# فاز ۲ — ممیزی UI فعلی و قراردادهای فاز ۱

تاریخ: ۲۰۲۶-۱۰-۲۸ · محدوده: فقط لایه UI اپ اندروید CloudGold

## ۱. UI فعلی چطور ساخته شده است

- UI اپ **Compose نیست**. کل رابط یک وب‌اپ فارسی (`app-web/`: `core.js`، `home.js`، `screens.js`، `app.css`) است که داخل یک WebView در `cloudgold/CloudGoldActivity.kt` اجرا می‌شود و از طریق پل `CGHost.call(...)` با Kotlin حرف می‌زند.
- پوشه `android/V2rayNG/app/src/main/assets/cloudgold` یک کپی قدیمی است؛ workflow ساخت APK هنگام بیلد `app-web/` را روی آن کپی می‌کند، پس منبع اصلی `app-web/` است.
- **تصمیم علی (۲۰۲۶-۱۰-۲۸):** بازطراحی فاز ۲ داخل همین وب‌اپ انجام می‌شود، نه Compose. پس «String Resource» = کاتالوگ رشته `app-web/i18n.js`، «Design Token» = `app-web/tokens.css`، و معادل LazyColumn/Stable State = رندر هدفمند DOM (فقط ردیف‌ها و گره‌هایی که عوض شده‌اند).
- هسته اتصال: v2rayNG 2.2.6 بدون تغییر (`CoreServiceManager`، `CoreVpnService`). سابسکریپشن CloudGold با شناسه ثابت `cloudgold` در MMKV وارد v2rayNG می‌شود (`CgVpn.sync`).

## ۲. قراردادهای فاز ۱ (استخراج‌شده از کد)

| نیاز صفحه | منبع | فیلد(ها) |
|---|---|---|
| وضعیت اتصال | سرویس VPN روی گوشی (نه API مرکزی) | broadcast های `MSG_STATE_RUNNING / START_SUCCESS / START_FAILURE / STOP_SUCCESS / NOT_RUNNING` |
| لیست سرور یکپارچه | `GET /vpn` → `subscription.sub_url` → محتوای سابسکریپشن (مستقیم یا از `GET /vpn/sub`) | هر سرور: `guid`، `remarks` (پرچم ← کد کشور، همان قانون `parseLink` سرور)، نوع پروتکل |
| تأخیر | تست روی گوشی | `MSG_MEASURE_DELAY` (سرور فعلی)، `MSG_MEASURE_CONFIG_START` (همه) |
| مصرف کل / باقیمانده / سهمیه | `GET /me` → `subscription` | `used_bytes`، `remaining_bytes`، `data_limit_bytes`، `unlimited_data` |
| انقضا | `GET /me` → `subscription` | `expires_at`، `days_left`، `seconds_left`، `unlimited_time`، `period_days` |
| دلیل توقف حساب | `GET /me` → `subscription.status` و `active` | `active` · `limited` (حجم تمام) · `expired` · `disabled` · `on_hold` · `missing` · `unknown`؛ و خطاهای `no_subscription`، `device_limit`، `sub_missing` |
| طرح‌ها | `GET /plans` | `id`، `name`، `duration_days`، `data_limit_gb` (۰ = نامحدود)، `device_limit`، `price_toman`، `old_price_toman`، `monthly_toman`، `save_percent`، `badge`، `trial_days` |
| تست رایگان | `POST /trial {plan_id}` | پاسخ = همان `/me` |
| رتبه سرور برای اپراتور | `GET /net/rank` | `isp`، `geo`، `servers{k:{score,n,ms,level}}`، `google{k:{status}}` |

## ۳. کمبودهای API (حدس زده نشد، سمت اپ جمع زده نشد)

1. **درصد مصرف / سطح هشدار** فیلد نداشت. به خواست علی فیلد `subscription.used_percent` به `GET /me` اضافه شد (عدد صحیح ۰ تا ۱۰۰، رو به پایین؛ برای حجم نامحدود `null`) و اپ هشدار ۸۰/۹۵/۱۰۰٪ را فقط از همین عدد نشان می‌دهد؛ هیچ درصدی سمت اپ حساب نمی‌شود.
2. **چندپنلی**: در کد فقط یک پنل PasarGuard هست (`env.PASARGUARD_URL`) و قانون ادغامی در فاز ۱ وجود ندارد؛ قانون جدیدی ساخته نشد.
3. **Kill Switch / Always-On**: API ندارد. اندروید وضعیت را فقط به خود سرویس VPN می‌گوید (`VpnService.isAlwaysOn()` / `isLockdownEnabled()`، اندروید ۱۰+). یک پیام فقط‌خواندنی از سرویس اضافه شد؛ منطق اتصال تغییر نکرد.
4. **پیام دلیل توقف** فقط کد است؛ متن‌ها در String Resource اپ نوشته شده‌اند.
5. تنظیمی که API جدید لازم دارد اضافه نشد (مثلاً همگام‌سازی سرورهای منتخب بین گوشی‌ها؛ منتخب‌ها فقط روی همین گوشی ذخیره می‌شوند).

## ۴. مشکلات UI فعلی

### دسترس‌پذیری
- `textZoom = 100`: اندازه فونت سیستم کاملاً نادیده گرفته می‌شود. (در صفحه‌های جدید اندازه‌ها با rem و `--fs` از `fontScale` اندروید بزرگ می‌شوند؛ textZoom همان ۱۰۰ می‌ماند تا صفحه‌های قدیمی ورود/پرداخت نشکنند.)
- چیدمان با مختصات مطلق روی شبکه ۳۹۰ واحدی و `scale`؛ در فونت بزرگ و چرخش صفحه می‌شکند. صفحه روی portrait قفل است.
- اسلایدر «برای اتصال بکش» در صفحه سرورها با TalkBack سخت است؛ وضعیت‌ها در چند جا فقط با رنگ (نقطه، نوار) منتقل می‌شوند.
- چند دکمه کوچک‌تر از ۴۸dp (برگشت ۳۲px، دکمه «انتخاب» ۳۰px ارتفاع).

### حریم خصوصی و امنیت
- کارت سرور صفحه خانه در نبود alias، **آدرس سرور** (`srv.server`) را نشان می‌دهد؛ پل `vpnServers` آدرس و پورت هر سرور را به UI می‌دهد.
- IP خروجی سرور (نود) روی خانه و صفحه سرورها نمایش داده می‌شود.
- پیام خطای خام هسته (`MSG_STATE_START_FAILURE` content) و `e.message` استثناها مستقیم به کاربر نشان داده می‌شوند.
- منوی «تنظیمات پیشرفته (v2rayNG)» صفحه v2rayNG را باز می‌کند که آدرس سابسکریپشن پنل و آدرس سرورها در آن دیده می‌شود.

### وضعیت و رفتار
- Kill Switch فقط یک راهنمای متنی است؛ اپ نمی‌داند فعال است یا نه.
- وقتی اشتراک تمام شده، دکمه اتصال به صفحه خرید می‌رود ولی دلیل (حجم / زمان / غیرفعال) فقط در یک برچسب کوچک است.
- هشدار مصرف فقط یک سطح دارد (≤۱۰٪ باقیمانده)، نه ۸۰/۹۵/۱۰۰٪.
- رشته‌ها داخل JS هاردکد شده‌اند؛ نسخه انگلیسی / LTR ندارد.
- حلقه `requestAnimationFrame` + `setInterval` هر ۵۰۰ms تا ۱s کل صفحه را دوباره رنگ می‌کند (globe canvas).

## ۵. توکن‌های استخراج‌شده

رنگ‌های برند فعلی (`--gilt #F3DDA0`، `--bullion #D6AE5C`، `--ivory #F2EADB`، پس‌زمینه `#0B0A08`) به یک سیستم سه‌لایه در `app-web/tokens.css` تبدیل شدند — جزئیات در [design-system.md](design-system.md):
- لایه ۱ (primitive): `--p-walnut-*`، `--p-bullion-*`، `--p-verdigris-*`، `--p-cinnabar-*`، `--p-amber-*`، `--p-platinum-*`، فاصله `--s-*`، شعاع `--r-*`، حرکت `--m-*`
- لایه ۲ (semantic، برای تم تیره و روشن): `--c-bg`، `--c-surface*`، `--c-text*`، `--c-accent`، و چهار وضعیت `--c-ok / --c-busy / --c-warn / --c-bad`
- لایه ۳ (component): `--btn-*`، `--row-min`، `--meter-*`، `--tab-h`، `--touch` (حداقل ۴۸px)

### اسکیل‌های استفاده‌شده
- `frontend-design` (anthropics/skills)
- `compose-editor` و `compose-performance-auditor` (javiercamarenatriguero/android-skills) — چون UI وب ماند، قواعدشان به معادل وب اعمال شد: تفکیک state از نما، کلید پایدار برای ردیف‌ها، به‌روزرسانی هدفمند به‌جای رندر کامل، کار سنگین بیرون از حلقه‌ی رسم.
- `design-system`: مخزن `supercent-io/skills-template` خصوصی است و دانلود نشد؛ معادل عمومی `design-system-patterns` از `wshobson/agents` استفاده شد (سلسله‌مراتب primitive → semantic → component).
