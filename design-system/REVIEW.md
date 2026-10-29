# web-design-guidelines review — UI redesign

Skill: `web-design-guidelines` (Vercel Web Interface Guidelines, fetched rules in full). Run last, over every file
changed by this PR: `app-web/tokens.css`, `index.html`, `i18n.js`, `core.js`, `ui.js`, `home.js`, `servers.js`,
`usage.js`, `plans.js`, `settings.js`, `screens.js` (D2 = A text pass only). Format follows the skill: `file:line`,
grouped by file. Line numbers are from the PR head.

## Fixed in this PR

### app-web/index.html
- index.html:5 — `maximum-scale=1, user-scalable=no` removed (anti-pattern "disabling zoom").
- index.html:6-7 — `<meta name="theme-color">` for dark (#0D1620) and light (#EEF2F5), matching page background.
- index.html:8 — `color-scheme: dark light`; index.html:10 sets `data-theme` before first paint (no flash).
- index.html:12-13 — critical fonts (Outfit, Michroma) `<link rel="preload" as="font">`.
- index.html:2 — `lang="en" dir="ltr"` (English-only app, D1).

### app-web/tokens.css
- tokens.css:110-112 — `prefers-reduced-motion`: all durations 0, animations off (incl. hallmark spin/strike).
- tokens.css:127 — `:focus-visible` ring on every interactive element; no bare `outline:none`.
- tokens.css:230 — search input `outline:none` is replaced by the group ring at tokens.css:228 (`:focus-within`).
- tokens.css:126 — `touch-action: manipulation` on buttons; tokens.css:118 tap highlight set intentionally.
- tokens.css:119-122 — `overflow-x:hidden`, `overscroll-behavior`, safe-area + `scroll-padding-bottom` so the tab
  bar never covers the focused element.
- tokens.css:246 — bottom sheet `overscroll-behavior: contain`.
- tokens.css:133-134, 143, 268 — `font-variant-numeric: tabular-nums` on every number readout.
- tokens.css:135-136, 249 — `text-wrap: balance` on headings.
- tokens.css:183, 199, 220, 273, 309-311, 326, 337-339, 362, 386-387 — flex/grid children `min-width:0` +
  `overflow-wrap:anywhere` (long server/plan names never clip or overflow).
- tokens.css:295-296 — SVG animation uses `transform-box: fill-box; transform-origin: center`.
- tokens.css:158, 211, 237, 292 — transitions list properties; no `transition: all` anywhere.
- tokens.css:368-369 — usage bar width transition removed (was a layout-property animation).
- tokens.css:408 — `forced-colors` support.
- tokens.css:132 — `h1.wordmark` margin reset.

### app-web/i18n.js
- i18n.js:23, 80, 143-146 — non-breaking space between number and unit (`12 GB`, `80 ms`, `… Toman`).
- i18n.js:10, 52, 55, 60 — loading states and placeholder end with `…`.
- i18n.js:135, 138, 150 — numbers and dates through `Intl` (`toLocaleString('en-US')`, `toLocaleDateString('en-GB')`).

### app-web/core.js
- core.js:7-8, 13, 36 — old screens' number/date formatting moved to `Intl` en-US/en-GB (was fa-IR).
- core.js:245-246 — `dir="ltr"` and `lang="en"` on every screen.

### app-web/ui.js
- ui.js:45 — all icons `aria-hidden="true"` and always next to a word.
- ui.js:69 — icon-only back button has `aria-label`.
- ui.js:75 — tab bar is `<nav aria-label>`.
- ui.js:115-120 — error text never shows the API's raw Persian message; English message with a next step.
- ui.js:140 — toasts announced through an `aria-live="polite"` region.

### app-web/home.js
- home.js:37 — wordmark is the screen's `<h1>`, `translate="no"` (brand).
- home.js:42, 93 — connect control is a real `<button>` whose `aria-label` says action + state; never colour alone.
- home.js:44 — state chip in an `aria-live="polite"` region.
- home.js:50, 113 — server name `translate="no"`, exactly as the API sends it; reading is a `<button>`.

### app-web/servers.js
- servers.js:37 — icon-only refresh button has `aria-label`.
- servers.js:44 — search: `<label>` wraps input, `type="search"`, `name="q"`, `autocomplete="off"`.
- servers.js:51 — result count announced `aria-live="polite"`.
- servers.js:69, 105, 111 — names `translate="no"`; favourite star and row have `aria-label`.
- servers.js:197 — loading skeleton has `role="status"` + label.

### app-web/usage.js, plans.js, settings.js
- usage.js:23 — usage bar `role="img"` with a spoken label (percent + amount).
- usage.js:65, 73 — sections `aria-labelledby` their headings.
- plans.js:31, 57 — plans are a `radiogroup` of `<button role="radio" aria-checked>`; radio and label share one hit target.
- plans.js:64 — number in readout font, currency as a separate word.
- settings.js:20, 130 — choice groups `radiogroup`; system-state rows say their real state in `aria-label`.

### app-web/screens.js (D2 = A)
- All UI strings English; `Rial` amounts via `toLocaleString('en-US')`.
- screens.js:752 / index.html:11 — brand text "Cloud Gold" only (was "Cloud Gold VPN").

## Remaining (deliberate or out of scope) — not fixed

| # | Rule | Where | Why it stays |
|---|------|-------|--------------|
| R1 | Title Case for headings/buttons | all i18n.js strings | MASTER §4 sets sentence case (approved); Android Material copy and the `frontend-design` calm, non-marketing voice use it. Conflicts with this guideline; kept as approved. |
| R2 | Buttons need `hover:` state | tokens.css (whole file) | Touch-only Android app; pressed (`:active`) and `:focus-visible` states exist instead. |
| R3 | URL reflects state / deep links / skip link | core.js router | Single-window WebView with a hash router; there is no address bar or keyboard-first page to skip in. |
| R4 | Animate transform/opacity only | tokens.css:158, 211, 237, 292 | Short colour/fill transitions (≤200 ms) on state change; all turned off under reduced motion. |
| R5 | Inline styles, hardcoded hex, 30×30 px buttons | screens.js:23-24, 79, 83, 738 and others | Older screens: D2 = A allows text only, no layout changes. The 390×844 stage is scaled to the phone, so the real target is larger, but not guaranteed 48 dp. Candidate for a later pass. |
| R6 | Content language | screens.js:404, 608, 653 | `admin_note`, coin `c.fa`, `memo_label` and bank names come from the API in Persian and are shown as sent. Fix belongs to the bot/Worker data, not the UI. |
| R7 | Plan names | `/plans`, `/me` `plan_name` | The Worker maps standard names to Persian. Rename plans in the bot (e.g. `/plan 1 name 1 Month`); no code change here by rule. |
| R8 | Minimal direction change (not text only) | screens.js:23 (back button left), chevrons `›`, `dir="ltr"` | Required so English text reads correctly in old screens; otherwise punctuation is reversed. Flagged to Ali. |
| R9 | `<img>` width/height | — | No `<img>` in changed flow screens (all SVG). |
| R10 | Large list virtualization | servers.js | Server list is far below 50 rows in practice. |

Every other rule in the guideline: pass.
