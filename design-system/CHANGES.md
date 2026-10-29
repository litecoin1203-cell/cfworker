# UI redesign — change summary per file

Scope: visual redesign of the `app-web/` WebView UI per the approved `design-system/MASTER.md`. No Worker, quota,
disconnect, panel-sync or v2rayNG change. Connect, disconnect and server switch still call `CG.connect` /
`CG.disconnect` / `CG.tab('servers')` exactly as before. Accounts, UUIDs and sessions are untouched.

Skill per part: **ui-ux-pro-max** (design system, product pattern, UX + pro-rules checklist), **frontend-design**
(direction "Vault & Hallmark", hallmark control, ingot bar, rate-sheet plans, anti-template review),
**design-system-patterns** (three token layers, semantic theme switch), **web-design-guidelines** (final review,
see `REVIEW.md`).

| File | What changed | Driven by |
|------|--------------|-----------|
| `design-system/MASTER.md` | New. Locked design system: skill trace, direction, wireframes, product facts, D1–D8, tokens with measured contrast, type, spacing, components, motion, a11y contract, checklist. | ui-ux-pro-max (`--design-system`, persist as MASTER), frontend-design, design-system-patterns |
| `app-web/tokens.css` | Rewritten on the PR #3 3-layer system (no parallel system): primitives `--p-*`, semantic `--c-*` per `data-theme` (steel + gold), component tokens (`--btn-*`, `--row-*`, `--hallmark-*`, `--ingot-*`). New components: hallmark, readings grid, ingot bar, rate-sheet plans, smart card, server rows, status chip. Reduced motion, forced colors, landscape layout, focus ring. | design-system-patterns (tiers, semantic aliases), frontend-design (visual language), ui-ux-pro-max (touch 48px, contrast ≥4.5, motion) |
| `app-web/index.html` | `lang="en" dir="ltr"`, zoom allowed, theme-color + color-scheme, theme set before first paint, fonts preloaded, title "Cloud Gold". | web-design-guidelines (theming, anti-patterns, performance) |
| `app-web/i18n.js` | English only: Persian table and language switch removed (D1). Intl number/date formatting, non-breaking unit spaces, `…` on loading strings, a few new keys (`us.of`, `pl.currency`, `pl.left`). | Ali's brief (English only), web-design-guidelines (typography, locale) |
| `app-web/ui.js` | Thinner 1.75 stroke icons, new `ingot` icon, `hallmark()` SVG (guilloché rosette, busy arc, strike ring, power glyph). Language icon and RTL flip removed. API Persian error text never shown. | frontend-design (signature element), ui-ux-pro-max (icon consistency) |
| `app-web/home.js` | New layout: wordmark + days-left chip, hallmark connect control with state chip and stop reason, readings grid (server, latency, connected for, this session), Kill Switch row. Server name exactly as API `remarks` (D8). Connect logic unchanged. | frontend-design (hallmark, readings), ui-ux-pro-max (state = icon + word + colour) |
| `app-web/servers.js` | Exact API names, no flag circle or translated country, protocol as subline, search over the name only, favourites and latency sort kept, skeleton rows. | Ali's brief (exact names, no panel info), ui-ux-pro-max (search/sort UX) |
| `app-web/usage.js` | Ring replaced by big percent + ingot bar with 80/95 ticks; all numbers from `/me` (`used_percent`, `remaining_bytes`, `days_left`, `seconds_left`, `status`); "Unlimited" text when unlimited. Warnings at 80/95/100 and stop reason unchanged. | frontend-design (ingot), ui-ux-pro-max (data clarity) |
| `app-web/plans.js` | Rate-sheet layout from `/plans` fields only (`name`, `badge`, `price_toman`, `old_price_toman`, `monthly_toman`, `save_percent`, `trial_days`). Radio + label one hit target. Payment flow call unchanged. | frontend-design (no three identical cards), ui-ux-pro-max |
| `app-web/settings.js` | Language choice removed (D1). Real Kill Switch / Always-On state from the system, auto-connect after boot, theme, account, version kept; new appearance block. | Ali's brief, ui-ux-pro-max |
| `app-web/core.js` | Always `ltr` + `lang="en"`; en-US numbers, en-GB dates, GB/MB/KB; English fallback messages; back arrow points left. | D2 = A, web-design-guidelines (Intl) |
| `app-web/screens.js` | D2 = A: all older-screen text translated to English (sign-in, onboarding, payments, card, crypto, orders, wallet, invite, account). Minimal direction fix so English reads correctly: back button on the left, chevrons `›`. No layout, logic or payment-flow change. | D2 = A |
| `.gitignore` | Ignore installed skills (`.agents/`, `.claude/skills/`, `skills-lock.json`). | — |
| `design-system/REVIEW.md` | web-design-guidelines report with file:line, fixed and remaining items. | web-design-guidelines |
| `design-system/DEVICE-TEST.md` | Real-phone test checklist. | ui-ux-pro-max pre-delivery checklist |

## Not done because the API has no field (reported, not guessed)
- Plan names and badges arrive in Persian from the Worker's name mapping; rename plans in the bot.
- `admin_note`, bank name, coin label and memo label arrive in Persian from the API in the old payment screens.

## D2 = A — translated files (text only)
| File | What was translated |
|------|---------------------|
| `app-web/screens.js` | All text of the screens outside the five (sign-in, sign-up, onboarding, payment choice, card, crypto, orders, wallet, invite, account, success). No layout, logic or payment-flow change. |
| `app-web/core.js` | Error and fallback messages (`NET_MSG`, "server busy", "Something went wrong.", default server name), number/date formatting to English. |
| `app-web/i18n.js` | Persian table removed; English table is the only one. |
| `app-web/ui.js` | `errText` never shows the API's Persian message; English text per error code. |
| `app-web/mock.js` | One message in the browser-only test stand-in (not loaded inside the app). |

### Strings left untranslated because logic depends on them
| Where | String | Why |
|-------|--------|-----|
| `app-web/core.js:10` | `۰۱۲۳۴۵۶۷۸۹` / `٠١٢٣٤٥٦٧٨٩` | Turns Persian/Arabic digits typed by the user into numbers (card, amount, code fields). |
| `app-web/screens.js:318` | `/^بانک\s*/` | Strips the word "Bank" in Persian from the bank name the API sends, so it is not shown twice. |
| `app-web/servers.js:18` | `ي`→`ی`, `ك`→`ک`, ZWNJ | Search normalisation so Arabic and Persian letters match the same server name. |

Data that arrives in Persian from the API (plan names/badges, `admin_note`, bank name, coin label, memo label) is shown as sent; it is fixed in the bot/Worker, not in the UI.
