# Cloud Gold — Design System (MASTER)

> Status: **DRAFT — waiting for Ali's approval.** Once approved this file is locked: screens follow it, and any
> change to a token or rule is made here first. Page-specific exceptions would go in `design-system/pages/<page>.md`
> (none exist; Master rules apply everywhere).

Scope: the five app screens drawn by `app-web/` inside the Android WebView — Connect (home), Servers, Usage,
Plans (buy / renew), Settings. The older flows in `screens.js` (sign-in, payments, orders, wallet, invite) are
out of scope and keep their current look.

Sources: `ui-ux-pro-max` (product pattern "Trust & Authority", style "Minimalism & Swiss", dark navy base, UX and
pro-rules checklists), `frontend-design` (direction and anti-template review), `design-system` (three-layer token
architecture), Android Material touch and state rules. Where the generated suggestion (navy + green, DM Sans)
was generic, it was replaced by the choices below and the reason is written next to each.

---

## 0. How each skill was applied (trace)

Order used, as Ali asked: ui-ux-pro-max → frontend-design → design-system → web-design-guidelines (the last
one runs at the end, on the rewritten files).

**Install** (`npx skills add`, inside the repo, into `.agents/skills/`, git-ignored):
`nextlevelbuilder/ui-ux-pro-max-skill` ✓ (also brought `design-system`, `ui-styling`, `brand`, `design`, `slides`),
`anthropics/skills --skill frontend-design` ✓, `vercel-labs/agent-skills --skill web-design-guidelines` ✓,
`supercent-io/skills-template --skill design-system` ✗ — "Authentication failed", the repository is private
(retried 2026-10-29, same result). The `design-system` skill installed with ui-ux-pro-max (claudekit, MIT) is
used for this step: same three-layer token method (primitive → semantic → component).

**ui-ux-pro-max** (SKILL.md → Workflow steps 1–4, `references/pro-rules.md`)
- Step 1, requirements: product = VPN utility app; audience = phone users in a censored network, short sessions;
  keywords = trust, privacy, premium, dark-first; stack = plain HTML/CSS/JS in an Android WebView. No listed
  stack matches (no React/Tailwind/Compose UI here), so per "Never assume a stack" no `--stack` rules were applied.
- Step 2, `--design-system "VPN privacy security mobile app premium" -p "Cloud Gold" --variance 5 --motion 3 --density 5`
  → pattern *Trust & Authority*, style *Minimalism & Swiss*, palette navy `#1E3A5F` + green CTA `#22C55E`,
  font DM Sans, anti-patterns "excessive decoration", "pure white backgrounds". Kept: pattern, style, dark-navy
  trust base, anti-patterns, standard density, subtle motion. Replaced (skill rule "verify fit for the user's
  product before applying; do not persist unverified output"): the green CTA and DM Sans, because the brand is
  gold and the app already bundles two fonts; see §3 and §4 for the reason on each line.
- Step 2b, persist: the tool's `--persist` writes `design-system/<slug>/MASTER.md`; Ali fixed the path as
  `design-system/MASTER.md`, so this file uses the same Master + `pages/` override structure at that path.
- Step 3, domain searches run: `"luxury gold premium dark" --domain color` (accent `#A16207` family → bullion),
  `"precise technical premium" --domain typography`, and one accessibility outcome per query in `--domain ux`:
  focus not obscured, touch target size, reduced motion, color-only, text scaling, loading feedback; plus
  `"accessibilityLabel touch safe-areas" --domain web` (safe-area insets, 8dp spacing). Results are in §7–§9.
- Pre-delivery checklist from `references/pro-rules.md` copied into §9 and run before the PR.

**frontend-design** (SKILL.md → "Ground your designs", "Process: plan, review, build, critique", "Restraint")
- Subject: a private line out of a censored network, sold as "gold"; primary job of the app: connect in one tap
  and know you are protected. Vernacular used: bullion vault, hallmark stamp, assay purity, guilloché engraving.
- Plan in two passes: palette as named hex values (§3 tier 1), type roles (§4), layout with ASCII wireframes
  (§1a), principles (§1). Reviewed against the calibration list; revisions are in §1b.
- Restraint: boldness spent only on the Hallmark connect control; one orchestrated motion (§7).

**design-system** (`references/token-architecture.md`, `component-tokens.md`, `states-and-variants.md`,
`scripts/validate-tokens.cjs`)
- Tokens stay three layers in the existing `app-web/tokens.css` (PR #3): primitives `--p-*`, semantic `--c-*`,
  component `--btn-*`/`--row-*`/… — extended, not duplicated.
- State priority from `states-and-variants.md`: disabled > loading > active > focus > (hover) > default.
- Baseline run of `validate-tokens.cjs` on the five screen files + `ui.js` (before the redesign): 0 hard-coded
  hex colours, 6 hard-coded rem values in inline `style=""` (servers.js, plans.js, usage.js). Target after the
  redesign: 0 and 0. The halo button's colours in `app.css` (`.pb`) are replaced by the token-driven Hallmark.

**web-design-guidelines** — runs last: fetches the current rules from
`vercel-labs/web-interface-guidelines/command.md` and reviews every changed file, reported as `file:line`.

## 1. Direction: "Vault & Hallmark"

Cloud Gold sells a private line out of the open network. The visual world is the **bullion vault**: cool
blue-steel walls, and gold that is *stamped*, not sprayed — the hallmark punched into a bar that certifies its
purity. Two ideas carry the whole app:

1. **Steel is quiet.** Surfaces are flat blue-steel tones separated by tone and hairlines. No glow, no glass,
   no gradient wash, no drop-shadow under every card.
2. **Gold is earned.** Gold appears only where something is *certified*: the connect hallmark when the tunnel is
   up, the selected server, the selected plan, the primary action. If everything were gold, nothing would be.

The one memorable element is the **Hallmark** connect control: a round stamp with a fine guilloché ring (the
engraved line pattern of banknotes and certificates). Disconnected it is engraved steel; connecting, the ring
draws itself around; connected, it is struck in gold. Everything around it stays disciplined.

What we deliberately do **not** use (frontend-design review): purple or blue-violet gradients; three identical
cards in a row; one radius on everything; soft grey shadow under every card; ALL-CAPS tracked eyebrow labels;
"A · B · C" meta strings; arrow glyphs appended to buttons; emoji used as UI icons; warm cream page with a
clay accent; near-black with one acid accent; glassmorphism.

### 1a. Layout wireframes (frontend-design: "ASCII wireframes to ideate and compare")

Start-aligned text; only the Hallmark block is centred.

```
Connect (portrait)             Connect (landscape ≥640px)          Usage
┌──────────────────────┐       ┌───────────────┬───────────────┐   ┌──────────────────────┐
│ Cloud Gold  [23 days]│       │ Cloud Gold    │      [23 days]│   │ Usage            [↻] │
│ [notice if any]      │       │   ╭───────╮   │ Server  🇩🇪 DE 2│   │ [80% warning notice] │
│      ╭───────╮       │       │   │  (⏻)  │   │ Latency 128 ms│   │ 82%  used of 50 GB   │
│      │  (⏻)  │       │       │   ╰───────╯   │ Time  01:24:07│   │ ▓▓▓▓▓▓▓▓▓▓▓▓▓░|░░|   │
│      ╰───────╯       │       │  ● Connected  │ Data   412 MB │   │ Used / Left / Total  │
│     ● Connected      │       │               │ Kill Switch ? │   │ Expires · days left  │
│ ┌─────────┬────────┐ │       └───────────────┴───────────────┘   │ [ Renew plan       ] │
│ │Server   │Latency │ │                                           └──────────────────────┘
│ │Duration │Session │ │       Servers                             Plans
│ └─────────┴────────┘ │       ┌──────────────────────┐            ┌──────────────────────┐
│ Kill Switch  Unknown │       │ Servers          [↻] │            │ Renew                │
├──────────────────────┤       │ [Fastest automatically]           │ Now: active, 9 GB…   │
│ Connect Servers Usage│       │ [ search            ]│            │ ○ Monthly     290,000│
│ Settings             │       │ All  Favorites  Sort │            │ ● Quarterly   790,000│
└──────────────────────┘       │ 🇩🇪 DE 2  ▮▮▮▮ 128 ☆ │            │ ○ Yearly    2,900,000│
                               │ 🇳🇱 NL 1  ▮▮▮  164 ☆ │            │ [ Renew with …     ] │
                               └──────────────────────┘            └──────────────────────┘
```

Compared alternative for Connect: big-number hero (timer as the hero, small button under it). Rejected: the
skill names "big number + small label" as the default treatment, and the person's first job is the button.

### 1b. Review against the calibration list (frontend-design "review that plan against the brief")

| Trait in the skill's list | Where the first plan was close | Revision |
|---|---|---|
| 2. near-black + one bright accent | first palette was walnut-black + gold (PR #3) | background moved to blue-steel `#0D1620` (a hue, not tinted black); gold limited to "certified" states |
| 4. SaaS card kit, one radius, same shadow | PR #3 used a card for every block | grouped lists, radius hierarchy 10/14/20/28/pill, no card shadows |
| 5. template chrome (ALL-CAPS eyebrows, `A · B · C`, `→` on buttons, mono data labels) | plan meta line used middle dots | facts are separate icon + text items; no eyebrows; numbers use Michroma, not a monospace |
| typography default (Inter as safe face) | `body` in `app.css` uses Inter | flow screens use Outfit + Michroma only |

## 2. Product facts the design must respect

- English UI by default (`lang="en"`, LTR). The existing Persian string table stays available in Settings →
  Language; RTL keeps working through logical properties (`inset-inline-*`, `margin-inline-*`).
- No panel name, address, count, host, port or exit IP on any screen, label, log or accessibility text.
- Server names are shown **exactly** as the API sends them (e.g. `🇩🇪 DE 2`) — no translation, no rewrite.
- Every number on Usage comes from `GET /me` (`subscription.*`); warnings use the server's `used_percent`.
- Plans come only from `GET /plans`; the payment flow (`CG.payFor`) is unchanged.
- Connect / disconnect / switch server keep calling the same functions in `vpn.js`.
- Kill Switch and Always-On show only what Android reports (`vpnPolicy`); "unknown" is a real state.

---

## 3. Tokens — three layers

Lives in `app-web/tokens.css` (the file from PR #3, extended — no parallel system). Screens use **only** tier 2
and tier 3 names. A raw hex, px colour or ad-hoc shadow in a screen stylesheet or JS template is a bug.

### Tier 1 — primitives (`--p-*`)

| Family | Tokens |
|---|---|
| Steel (dark neutrals) | `--p-steel-950 #0D1620` · `--p-steel-900 #15212D` · `--p-steel-800 #1D2B39` · `--p-steel-700 #273849` · `--p-steel-600 #2A3B4C` · `--p-steel-400 #7A8A9A` · `--p-steel-300 #8797A8` · `--p-steel-200 #A8B6C4` · `--p-steel-50 #EDF1F5` |
| Platinum (light neutrals) | `--p-plat-0 #FFFFFF` · `--p-plat-50 #EEF2F5` · `--p-plat-100 #E3E9EE` · `--p-plat-200 #D3DCE3` · `--p-plat-300 #CDD7DF` · `--p-plat-500 #6B7B8C` · `--p-plat-600 #56677A` · `--p-plat-700 #465668` · `--p-plat-900 #122030` |
| Bullion (brand) | `--p-gold-300 #F1D493` · `--p-gold-400 #E3B55B` · `--p-gold-700 #86600E` · `--p-gold-950 #1B1405` |
| Verdigris (ok) | `--p-green-300 #5ED3A4` · `--p-green-700 #0F6B4B` · `--p-green-100 #D5F0E5` · `--p-green-900 #0F3328` |
| Amber (warn) | `--p-amber-300 #F2B65A` · `--p-amber-700 #8A5600` · `--p-amber-100 #FBE8C6` · `--p-amber-900 #3A2808` |
| Cinnabar (bad) | `--p-red-300 #F38E78` · `--p-red-700 #A8341D` · `--p-red-100 #F9DDD5` · `--p-red-900 #43170F` |

Why not the generated navy `#1E3A5F` + green `#22C55E`: green CTA on navy is the stock "VPN template". Steel
keeps the trust tone of the navy suggestion; bullion is the brand; green is reserved for "connected/ok" only.

### Tier 2 — semantic roles (`--c-*`), per theme

| Role | Dark "Vault" (default) | Light "Platinum" | Use |
|---|---|---|---|
| `--c-bg` | steel-950 | plat-50 | page |
| `--c-surface` | steel-900 | plat-0 | grouped lists, sheets, tab bar |
| `--c-surface-2` | steel-800 | plat-100 | quiet buttons, chips, skeletons |
| `--c-surface-3` | steel-700 | plat-200 | meter track, pressed fill |
| `--c-line` | steel-600 | plat-300 | hairline dividers (decorative only) |
| `--c-control` | steel-400 | plat-500 | outlines that carry meaning: switch track, radio ring, input border (≥3:1) |
| `--c-text` | steel-50 | plat-900 | primary text |
| `--c-text-2` | steel-200 | plat-700 | secondary text |
| `--c-text-3` | steel-300 | plat-600 | tertiary / placeholder |
| `--c-accent` | gold-400 | gold-700 | brand gold: primary action, selection, connected hallmark |
| `--c-on-accent` | gold-950 | plat-0 | text/icon on gold |
| `--c-accent-soft` | gold-400 @ 12% | gold-700 @ 10% | selected row / chip fill |
| `--c-focus` | gold-300 | gold-700 | 3px focus ring |
| `--c-ok` / `--c-ok-bg` | green-300 / green-900 | green-700 / green-100 | connected, active plan |
| `--c-busy` / `--c-busy-bg` | gold-300 / gold-950 | gold-700 / amber-100 | connecting, disconnecting |
| `--c-warn` / `--c-warn-bg` | amber-300 / amber-900 | amber-700 / amber-100 | 80 % used, ≤3 days, unknown policy |
| `--c-bad` / `--c-bad-bg` | red-300 / red-900 | red-700 / red-100 | 95 %/100 %, stopped, error |
| `--c-scrim` | rgba(4,8,12,.72) | rgba(18,32,48,.45) | sheet backdrop |

Theme is chosen in Settings (System / Dark / Light) and written to `data-theme` on `<html>`; System follows
`prefers-color-scheme`. Both themes are designed, neither is derived.

**Measured contrast (WCAG 2.x):**

| Pair | Dark | Light |
|---|---|---|
| text on bg / surface | 16.1 / 14.4 | 14.6 / 16.5 |
| text-2 on bg / surface / surface-2 | 8.8 / 7.9 / 7.0 | 6.7 / 7.5 / 6.2 |
| text-3 on bg / surface / surface-2 | 6.1 / 5.5 / 4.8 | 5.2 / 5.8 / 4.7 |
| accent (gold) on bg / surface | 9.6 / 8.6 | 5.1 / 5.7 |
| on-accent on accent | 9.6 | 5.7 |
| ok / warn / bad on their -bg | 7.4 / 7.8 / 6.5 | 5.4 / 5.1 / 5.2 |
| control vs surface (non-text, needs 3) | 4.6 | 4.3 |

Every text pair ≥ 4.5. `--c-line` (≈1.4) is decorative only and never the sole boundary of a control.

### Tier 3 — component tokens

| Token | Value | Notes |
|---|---|---|
| `--touch` | `max(48px, 3rem)` | minimum hit area; grows with font scale |
| `--btn-h` | `max(52px, 3.25rem)` | primary/quiet buttons |
| `--btn-primary-bg / -fg` | accent / on-accent | |
| `--btn-quiet-bg / -fg` | surface-2 / text | |
| `--row-min` | `max(56px, 3.5rem)` | list rows |
| `--tab-h` | `max(64px, 4rem)` | bottom tab bar |
| `--hallmark-size` | `min(64vw, 15rem)` | connect control; shrinks in landscape (`min(42vh, 13rem)`) |
| `--hallmark-ring` | control (off), busy (connecting), accent (on), bad (blocked) | |
| `--ingot-h` | `0.875rem` | usage bar |
| `--ingot-tick` | text-3 | 80 / 95 / 100 marks |
| `--meter-track` | surface-3 | |
| `--switch-track-off` | transparent + 2px `--c-control` | so the off state passes 3:1 |
| `--switch-track-on` | accent | thumb `--c-on-accent` |

---

## 4. Typography

| Role | Family | Size (rem, × font scale) | Weight / line-height | Use |
|---|---|---|---|---|
| Wordmark | Michroma | 1.125 | 400 / 1.2, tracking +0.02em | "Cloud Gold" in the top bar only |
| Readout L | Michroma | 2.25 | 400 / 1.15, `tabular-nums` | connection timer, usage % , days left |
| Readout M | Michroma | 1.25 | 400 / 1.25, `tabular-nums` | latency, session data, prices |
| H1 | Outfit | 1.5 | 600 / 1.3 | screen titles |
| H2 | Outfit | 1.125 | 600 / 1.4 | section titles inside a screen |
| Title | Outfit | 1 | 500 / 1.45 | row titles, plan names |
| Body | Outfit | 0.9375 | 400 / 1.55 | paragraphs, notices |
| Small | Outfit | 0.8125 | 400 / 1.5 | secondary lines, hints |
| Label | Outfit | 0.75 | 500 / 1.4, sentence case | tab labels, captions |

- Both fonts are already bundled in `app-web/fonts/` (OFL), so no download, no network font, no APK growth.
  Michroma is a wide, engraved-looking face — the "stamped number" of the hallmark; it is used **only** for the
  wordmark and numeric readouts, never for sentences. Outfit is a round geometric sans that matches the coin
  and stays very legible at 1.6× scale. Persian text falls back to Vazirmatn through the existing
  `unicode-range` faces.
- Why not the generated DM Sans: it would mean a new font file and adds no character the bundled pair lacks.
- Body is 15px at 1.0 scale, never below 12px. All sizes are `rem`; `html { font-size: calc(16px * var(--fs)) }`
  where `--fs` is Android's font scale (clamped 0.85–2.0), so 1.6 is honoured.
- No ALL-CAPS labels, no one-word colour accents in headings. Numbers that can change use `tabular-nums` so
  they do not jitter. The timer is always LTR.

## 5. Spacing, layout, radius, elevation

- **Spacing** — 4px grid in rem: `--s-1 .25` `--s-2 .5` `--s-3 .75` `--s-4 1` `--s-5 1.25` `--s-6 1.5`
  `--s-8 2` `--s-12 3`. Section rhythm: 8 inside a row, 16 between items, 24 between groups, 32 between zones.
- **Gutter** — `--gutter: 1.25rem` (portrait), `2rem` in landscape ≥ 640px. Content column max `34rem`;
  landscape home splits into two columns (hallmark | readings) max `56rem`.
- **Alignment** — start-aligned everywhere except the hallmark block, which is centred.
- **Radius (hierarchy, not one value)** — `--r-chip 10px` (chips, small buttons) · `--r-control 14px`
  (inputs, rows when standalone) · `--r-group 20px` (grouped list, usage panel) · `--r-sheet 28px` (bottom
  sheets) · `--r-pill 999px` (primary button, status chip). The hallmark is a circle.
- **Elevation** — dark theme: none; depth is surface tone (bg → surface → surface-2). Light theme: one token,
  `--e-sheet: 0 -8px 24px rgba(18,32,48,.12)`, used only by bottom sheets and the tab bar. No card shadows.
- **Containers** — information is grouped into one **grouped list** per topic (rows separated by hairlines),
  not a grid of identical cards. A screen has at most one tinted panel (usage ingot panel).
- **Safe areas** — top and bottom insets from `--safe-top` / `--safe-bottom`; scroll content is padded by the
  tab bar height so nothing hides behind it.
- **No horizontal overflow** — every flex child that holds text has `min-width:0`; long server or plan names
  wrap (`overflow-wrap:anywhere`), never get cut with an ellipsis that hides the only distinguishing part.

## 6. Components (shared, in `app-web/ui.js` + `tokens.css`)

| Component | Look | States / a11y |
|---|---|---|
| **Hallmark** (connect) | circle, guilloché ring (SVG strokes in `--hallmark-ring`), power glyph centre, state word under it | `button`, `aria-label` = action + state; off → steel ring; connecting → ring draws (stroke-dashoffset), word "Connecting"; on → gold ring + gold glyph; blocked → red ring + "Renew"; disabled while disconnecting |
| **Status chip** | pill, icon + word + colour | never colour alone; `aria-live="polite"` region on home |
| **Readings** (home) | 2×2 grid of label + Readout M inside one grouped surface: Server · Latency · Duration · This session | dimmed (text-2) when not connected, shows "—" not zeros |
| **Grouped list / row** | surface, hairline between rows, `--row-min` | pressed = surface-3 fill (no scale, no layout shift) |
| **Server row** | exact API name (Title), latency readout + 4-bar quality glyph, star toggle | `aria-pressed` on star with name in label; current server = gold text + "Connected" chip; whole row ≥ 56px |
| **Ingot** (usage) | horizontal bar with square ends (a bar of gold), fill = `used_percent`, ticks at 80/95/100 | ok → accent fill, 80 → warn, 95/100 → bad; `role="img"` + full sentence label; unlimited shows "Unlimited" text, no bar |
| **Notice** | tinted bar with icon, title, one line, optional action | `role="alert"` for warn/bad, `status` otherwise |
| **Plan row** | rate-sheet row: name + badge, data · days · devices as icon facts, price as Readout M, radio | `role="radio"` in a `radiogroup`; selected = gold 2px outline + soft fill; old price struck through with its own label |
| **Buttons** | primary (gold pill), quiet (surface-2 pill), outline (control ring), danger (red outline) | pressed = `filter: brightness(.92)`; disabled = 38 % + `aria-disabled`; busy = spinner keeps width |
| **Switch** | track outline 2px `--c-control` when off, gold when on | `role="switch"`, `aria-checked` changes only after the system answers |
| **Chip** (filters, choices) | 10px radius, 48px tall | `aria-pressed` or `role="radio"` + `aria-checked` |
| **Bottom sheet** | surface, 28px top radius, grab bar | `role="dialog"`, focus to title, back button closes, focus returns |
| **Tab bar** | 4 tabs: Connect, Servers, Usage, Settings; icon + label, active = gold icon on soft pill | `nav` with `aria-label`, `aria-current="page"` |

Icons: one in-house SVG set in `ui.js` (24px grid, 1.75px stroke, round caps, outline style), sizes
`--ic-sm 1rem`, `--ic-md 1.375rem`, `--ic-lg 1.5rem`. Decorative icons are `aria-hidden="true"`.

## 7. Interaction & motion

| Token | Value | Use |
|---|---|---|
| `--m-quick` | 120ms | press feedback, chip toggle |
| `--m-standard` | 240ms | switch, sheet fade, colour changes |
| `--m-emph` | 420ms | ingot fill, hallmark ring settle |
| `--m-draw` | 1600ms linear, repeating | hallmark ring drawing while connecting |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` | enter / settle |
| `--ease-exit` | `cubic-bezier(.4,0,1,1)` | exits are faster than entries |
| `--st-pressed` | .12 | pressed overlay |
| `--st-disabled` | .38 | disabled opacity |

- One orchestrated moment only: the hallmark "strike" when the tunnel comes up (ring closes, glyph turns gold,
  420ms). No entrance animations on lists or cards, no hover effects (touch device).
- Feedback within 120ms on every tap. Press never changes layout size.
- `prefers-reduced-motion: reduce` → no drawing, no strike; states switch instantly; the timer still ticks.
- Focus: 3px `--c-focus` outline with 2px offset on every focusable element (TalkBack and keyboards).

## 8. Accessibility contract (checked on every screen)

- Dark and light themes both pass the contrast table in §3.
- Font scale 1.6: no clipped text, no horizontal scroll at 320px wide; rows grow in height.
- Landscape: home switches to two columns; lists keep one column with wider gutters.
- TalkBack: every control has a name; icon-only controls carry `aria-label`; state changes are announced via
  the polite live region; star, chips, plans and switches expose pressed/checked state.
- Touch targets ≥ 48px (`--touch`) with ≥ 8px between neighbours.
- No information by colour alone: every state has an icon and a word.

## 9. Pre-delivery checklist (from ui-ux-pro-max pro-rules)

- [ ] No emoji used as a UI icon (country flags inside API server names are content and stay as sent)
- [ ] Only tier-2/3 tokens in screens; no raw hex in `home.js`, `servers.js`, `usage.js`, `plans.js`, `settings.js`, `ui.js`
- [ ] Pressed states do not shift layout
- [ ] Both themes checked separately; sheet scrim measured
- [ ] 320px / 375px / landscape / font 1.6 checked, no horizontal scroll
- [ ] Reduced motion checked
- [ ] Every icon control named; focus order = visual order
- [ ] No panel or server address anywhere (UI, `aria-label`, `console`)
