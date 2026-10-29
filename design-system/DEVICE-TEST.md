# Real-phone test checklist — UI redesign

Install the APK from the "Build Cloud Gold APK" run of this PR. Sign in with an existing account (must keep working
without signing up again). Tick each line; note the phone model, Android version and screenshot for any failure.

## 1. Account and session
- [ ] Existing account opens straight to Connect without a new sign-in.
- [ ] Same UUID as before (Settings → Account, or the bot `/user`), no new account created.

## 2. Connect screen
- [ ] Tap the hallmark: connects; state chip says "Connected"; rim turns gold; latency and timer start.
- [ ] Tap again: disconnects; chip says "Disconnected".
- [ ] Turn mobile data off while connected: "connection dropped" notice appears with a reason.
- [ ] Days-left chip matches `/me` (bot `/user` days left).
- [ ] Kill Switch row shows the real Android state (On / Off / Unknown) and opens Settings.

## 3. Servers
- [ ] Each name is exactly what the API sends (e.g. `🇩🇪 DE 2`); no address, host, panel name or panel count anywhere.
- [ ] Search, favourites (star) and sort by latency work; "Test all latencies" works.
- [ ] Switching server while connected reconnects to the new one (same behaviour as before).

## 4. Usage
- [ ] Percent, used, total, remaining and days left equal the bot's `/user` numbers.
- [ ] At ≥80 %, ≥95 % and 100 % the right warning shows (use `/grant` or a small test plan).
- [ ] Expired or disabled account shows the stop reason and a Renew/Support button.

## 5. Plans and payment
- [ ] Plans and prices equal the bot's plan list; sale price, monthly price and saving show only when set.
- [ ] Buy → payment screen → card / wallet flow behaves exactly as before; order appears in "My payments".

## 6. Settings
- [ ] No language option. Theme: System / Dark / Light switch immediately and survive an app restart.
- [ ] Always-On and Kill Switch status match Android settings; buttons open the right Android screen.
- [ ] Auto-connect after boot: restart the phone, tunnel comes up.
- [ ] Version line reads "Cloud Gold x.y.z · core v2rayNG 2.2.6".

## 7. Accessibility and layout
- [ ] Android font size at largest (≈1.6): no clipped or overlapping text on all five tabs and the old screens.
- [ ] Landscape: Connect shows two columns; nothing cut off; no sideways scrolling anywhere.
- [ ] Remove animations (Settings → Accessibility): hallmark does not spin or flash.
- [ ] TalkBack: connect button says action + state; every icon button says what it does; server rows read name,
      protocol and latency; no panel name or address is spoken.
- [ ] Every tap target feels at least a finger wide; no double-tap zoom delay.
- [ ] Dark and light: text is readable in sunlight and at night.

## 8. Old screens (English text pass)
- [ ] Sign-in, onboarding, wallet, my payments, card payment, crypto payment, invite and account read in English,
      with the back arrow on the left. Persian text that remains is data from the server (plan names, admin note,
      bank name) — rename in the bot.
- [ ] VPN leak test unchanged from Phase 1 (IP + DNS on a leak-test site while connected).
