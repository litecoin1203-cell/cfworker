/* Every visible text, accessibility label and error message of the app screens: CG.t('key', {var}).
 * The app is English only (Ali, 2026-10-29): one string table, left to right, Western digits, Gregorian dates.
 * Must load before core.js. */
(function () {
  'use strict';

  const en = {
    'app.name': 'Cloud Gold',
    'common.back': 'Back', 'common.close': 'Close', 'common.retry': 'Try again', 'common.later': 'Later', 'common.cancel': 'Cancel',
    'common.on': 'On', 'common.off': 'Off', 'common.loading': 'Loading…', 'common.sep': ', ',
    'tab.home': 'Connect', 'tab.servers': 'Servers', 'tab.usage': 'Usage', 'tab.settings': 'Settings', 'tab.nav': 'Main sections',
    'conn.connected': 'Connected', 'conn.connecting': 'Connecting', 'conn.disconnecting': 'Disconnecting', 'conn.disconnected': 'Disconnected',
    'conn.error': 'Error', 'conn.blocked': 'Cannot connect',
    'conn.sub.connected': 'Your phone’s traffic goes through the secure tunnel.',
    'conn.sub.connecting': 'One moment.',
    'conn.sub.finding': 'Finding the fastest server for your internet',
    'conn.sub.disconnecting': 'Closing the tunnel',
    'conn.sub.disconnected': 'Your connection is not protected.',
    'conn.btn.connect': 'Connect', 'conn.btn.disconnect': 'Disconnect', 'conn.btn.cancel': 'Cancel connecting',
    'conn.btn.renew': 'Renew plan', 'conn.btn.buy': 'Buy a plan',
    'conn.a11y.button': 'Connect button. State: {state}',
    'conn.server': 'Server', 'conn.latency': 'Latency', 'conn.duration': 'Connected for', 'conn.session': 'This session',
    'conn.ms': '{n} milliseconds', 'conn.ms.short': '{n}\u00A0ms', 'conn.none': '—',
    'conn.smart': 'Smart connect', 'conn.smart.on': 'Fastest server, automatically', 'conn.pick': 'Choose a server', 'conn.change': 'Change server',
    'conn.ks.label': 'Kill Switch', 'conn.ks.on': 'On', 'conn.ks.off': 'Off', 'conn.ks.unknown': 'Unknown', 'conn.ks.a11y': 'Kill Switch: {state}. Tap for details.',
    'conn.quality': 'Quality', 'conn.q.great': 'Great', 'conn.q.good': 'Good', 'conn.q.fair': 'Fair', 'conn.q.poor': 'Poor', 'conn.q.down': 'No response',
    'conn.offline': 'Your phone is offline. The connection resumes when the internet is back.',
    'conn.dropped': 'The VPN disconnected',
    'conn.dropped.sub': 'It closed without you asking; another VPN app may have started, or the system closed it.',
    'conn.weak': 'This server is not responding. Try another one.',
    'stop.limited': 'Your data is used up', 'stop.limited.sub': 'All data on this plan is used. Connecting is paused until you renew.',
    'stop.expired': 'Your plan has expired', 'stop.expired.sub': 'The expiry date has passed. Connecting is paused until you renew.',
    'stop.disabled': 'Your plan is disabled', 'stop.disabled.sub': 'This plan is disabled. Contact support for details.',
    'stop.missing': 'Your plan was not found', 'stop.missing.sub': 'Contact support so we can check your plan.',
    'stop.none': 'No active plan', 'stop.none.sub': 'Buy a plan or start the free trial to connect.',
    'stop.on_hold': 'Your plan has not started', 'stop.on_hold.sub': 'It starts with your first connection.',
    'stop.support': 'Message support',
    'err.network': 'Could not reach the server. Check your internet and try again.',
    'err.server': 'The server is busy. Try again in a moment.',
    'err.generic': 'That did not work. Try again.',
    'err.start_failed': 'Could not connect to this server. Try another one.',
    'err.timeout': 'Connecting took too long. Try another server.',
    'err.denied': 'VPN permission was not given. Accept Android’s VPN request to connect.',
    'err.device_limit': 'This plan is on its maximum number of phones. Remove an old phone in Account & devices.',
    'err.no_servers': 'No servers are set up for your plan yet. Try again in a few minutes.',
    'err.no_subscription': 'Buy a plan or start the free trial to use the VPN.',
    'err.sub_missing': 'Your plan was not found on the server. Contact support.',
    'err.panel_unavailable': 'Servers are not reachable right now. Try again in a few minutes.',
    'err.not_connected': 'Connect to a server first.',
    'fo.next': 'This server did not answer; trying the next one.',
    'fo.resync': 'No server answered; fetching a fresh list.',
    'sv.title': 'Servers', 'sv.search': 'Search servers…', 'sv.search.a11y': 'Search servers',
    'sv.filter.all': 'All', 'sv.filter.fav': 'Favorites', 'sv.filter.google': 'Works with Google & Gemini', 'sv.filters.a11y': 'Filters',
    'sv.sort.latency': 'Sort: lowest latency', 'sv.sort.default': 'Sort: default',
    'sv.test': 'Test all latencies', 'sv.testing': 'Testing…', 'sv.refresh': 'Refresh list',
    'sv.smart.title': 'Fastest server, automatically', 'sv.smart.sub': 'If a server stops answering, the next one is picked for you.', 'sv.smart.active': 'Selected',
    'sv.favs': 'Favorites', 'sv.all': 'All servers',
    'sv.empty.search': 'No server matches that name.', 'sv.empty.fav': 'No favorites yet. Tap the star next to a server.',
    'sv.empty.google': 'No server is confirmed for Google yet.', 'sv.empty.none': 'The server list is empty.',
    'sv.loading': 'Loading servers…', 'sv.nosub': 'Buy or renew a plan to see the servers.',
    'sv.fav.add': 'Add {name} to favorites', 'sv.fav.remove': 'Remove {name} from favorites',
    'sv.row.a11y': '{name}, {proto}, {latency}{state}', 'sv.row.current': ', current server',
    'sv.lat.unknown': 'latency unknown', 'sv.lat.fail': 'no response', 'sv.lat.value': 'latency {n} milliseconds',
    'sv.best': 'Best on {isp}', 'sv.updated': 'Server list updated.', 'sv.stale': 'Could not reach the server; kept the previous list.',
    'sv.tested': 'Latency test finished.', 'sv.count': '{n} servers',
    'us.title': 'Usage', 'us.time': 'Time left', 'us.used': 'Used', 'us.remaining': 'Remaining', 'us.total': 'Total data', 'us.unlimited': 'Unlimited',
    'us.expiry': 'Expires on', 'us.days_left': 'days left', 'us.hours_left': 'hours left', 'us.no_expiry': 'No expiry date',
    'us.devices': 'Phones', 'us.plan': 'Plan',
    'us.ring.a11y': 'Used {used} of {total}. {left} remaining.', 'us.of': 'used of {total}', 'us.days.a11y': '{n} days until the plan ends',
    'us.w80': 'Over 80% of your data is used', 'us.w80.sub': '{left} left. Consider renewing so you are not cut off.',
    'us.w95': 'Over 95% of your data is used', 'us.w95.sub': 'Only {left} left; connecting will stop soon.',
    'us.w100': 'Your data is used up', 'us.w100.sub': 'Connecting is paused until you renew or buy a new plan.',
    'us.wdays': 'Only {n} days left on your plan',
    'us.stale': 'Live data from the server was not available; showing the last saved numbers.',
    'us.updated': 'Plan details updated.', 'us.refresh': 'Refresh', 'us.renew': 'Renew or change plan', 'us.account': 'Account & devices',
    'us.status.active': 'Active', 'us.status.limited': 'Data used up', 'us.status.expired': 'Expired', 'us.status.disabled': 'Disabled',
    'us.status.on_hold': 'Not started', 'us.status.missing': 'Not found', 'us.status.unknown': 'Active',
    'pl.title': 'Buy & renew', 'pl.sub.renew': 'The new plan is applied to this same account; no new account or UUID is created.', 'pl.sub.buy': 'Choose a plan.',
    'pl.data': 'Data', 'pl.duration': 'Duration', 'pl.price': 'Price', 'pl.devices': 'Phones',
    'pl.gb': '{n}\u00A0GB', 'pl.days': '{n}\u00A0days', 'pl.toman': '{n}\u00A0Toman', 'pl.currency': 'Toman', 'pl.left': 'left', 'pl.devices.n': 'Up to {n} phones', 'pl.unlimited': 'Unlimited',
    'pl.off': '{n}% off', 'pl.trial': '{n}-day free trial',
    'pl.cta.buy': 'Buy this plan', 'pl.cta.renew': 'Renew with this plan', 'pl.cta.trial': 'Start the {n}-day free trial',
    'pl.after': 'After payment, your usage and expiry are refreshed from the server and shown here.',
    'pl.empty': 'No plans are on sale right now. Check back soon.',
    'pl.select.a11y': '{name} plan, {data}, {days}, {price}', 'pl.selected': 'Selected',
    'pl.orders': 'My payments', 'pl.support': 'Questions? Message support',
    'pl.done.title': 'Plan updated', 'pl.done.sub': 'New status from the server: {status}, {left} left, {days}.',
    'pl.trial.done': 'Free trial started. Tap connect.',
    'st.title': 'Settings', 'st.protect': 'Protection',
    'st.ks': 'Kill Switch', 'st.ks.sub': 'If the VPN drops, the phone’s internet stops too, so your real IP never leaks.',
    'st.aon': 'Always-on VPN', 'st.aon.sub': 'Android reconnects the VPN after a restart or a drop.',
    'st.state.on': 'On in the system', 'st.state.off': 'Off in the system',
    'st.state.unknown': 'Unknown; can only be checked while connected', 'st.state.old': 'Unknown; this Android version does not tell apps',
    'st.sys.title': 'Turn on in Android settings',
    'st.sys.why': 'Only Android itself can turn these on; the app cannot do it for you. They show as “On” here only when Android confirms it.',
    'st.sys.s1': 'Tap the button below to open Android’s VPN page.', 'st.sys.s2': 'Tap the gear next to Cloud Gold.',
    'st.sys.s3': 'Turn on “Always-on VPN”.', 'st.sys.s4': 'Turn on “Block connections without VPN” (this is the kill switch).',
    'st.sys.open': 'Open Android VPN settings', 'st.sys.failed': 'Could not open VPN settings; go to Settings → Network → VPN.',
    'st.sys.back.on': 'Android confirms: {what} is on.', 'st.sys.back.off': '{what} is not on in Android yet.', 'st.sys.back.unknown': 'We will check this while you are connected.',
    'st.conn': 'Connection', 'st.auto': 'Connect automatically after the phone starts', 'st.auto.sub': 'The last selected server connects by itself.',
    'st.auto.denied': 'VPN permission was not given, so automatic connect stayed off.', 'st.auto.noserver': 'Connect to a server once first, then turn this on.',
    'st.smart': 'Smart connect', 'st.smart.sub': 'Picks the fastest server, and the next one if it drops.',
    'st.google': 'Google & Gemini mode', 'st.google.sub': 'Smart connect only picks servers Google does not see as Iran.',
    'st.iran': 'Iranian sites without VPN', 'st.iran.sub': 'Banks and local sites open directly and do not use your data.',
    'st.notif': 'Notifications', 'st.notif.sub': 'Connection status and speed notification.',
    'st.notif.denied': 'Notification permission was not given. You can turn it on in Android settings.', 'st.notif.open': 'Open notification settings',
    'st.notif.off': 'Notifications are turned off in Android settings.',
    'st.look': 'Appearance', 'st.theme': 'Theme', 'st.theme.system': 'Same as phone', 'st.theme.dark': 'Dark', 'st.theme.light': 'Light',
    'st.account': 'Account', 'st.acc.devices': 'Account & devices', 'st.acc.wallet': 'Wallet', 'st.acc.invite': 'Invite friends',
    'st.acc.orders': 'My payments', 'st.acc.support': 'Support', 'st.acc.logout': 'Sign out',
    'st.logout.title': 'Sign out?', 'st.logout.sub': 'The VPN on this phone disconnects. Sign in again any time.',
    'st.servers': 'Servers', 'st.about': 'About', 'st.version': 'App version', 'st.core': 'Connection core', 'st.saved': 'Saved.',
    'st.recheck': 'Check again', 'st.short.on': 'On', 'st.short.off': 'Off', 'st.short.unknown': 'Unknown', 'st.gtest': 'Test Google & Gemini on this connection',
    'st.gtest.ok': 'This connection works for Google and Gemini', 'st.gtest.bad': 'This connection is not good for Google',
    'st.gtest.sees': 'Country Google sees', 'st.gtest.gemini': 'Gemini', 'st.gtest.open': 'Open', 'st.gtest.closed': 'Closed',
    'st.gtest.search': 'Google search', 'st.gtest.normal': 'Normal', 'st.gtest.captcha': 'Captcha / suspicious',
    'st.gtest.fail': 'The test did not finish; try again.', 'st.gtest.fix': 'Connect to a server that works for Google',
    'st.gtest.needconn': 'This test works only while connected.', 'st.pass': 'Change password',
    'st.notif.on': 'On in the system', 'st.notif.offstate': 'Off in the system',
    'pl.badge': 'Our pick', 'pl.monthly': '{n} a month', 'pl.trial.cta.sub': 'Buy only if you like it.',
    'pl.err.load': 'Could not load the plans.', 'pl.now': 'Current status: {status}',
  };

  const lang = 'en';

  function t(key, vars) {
    let s = en[key];
    if (s == null) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
    return s;
  }
  // digits after the decimal point kept as given
  function n(v, digits) {
    const num = Number(v || 0);
    return num.toLocaleString('en-US', digits == null ? undefined : { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }
  // two-digit number for clocks (05)
  const n2 = (v) => Number(v || 0).toLocaleString('en-US', { minimumIntegerDigits: 2, useGrouping: false });
  const UNITS = ['KB', 'MB', 'GB', 'TB'];
  // bytes from the API shown in binary units (1 GB = 1024³ bytes, as the panel counts them)
  function size(b) {
    b = Math.max(0, Number(b || 0));
    if (b >= 1024 ** 4) return n(b / 1024 ** 4, 2) + '\u00A0' + UNITS[3];
    if (b >= 1024 ** 3) return n(b / 1024 ** 3, b >= 100 * 1024 ** 3 ? 0 : 2) + '\u00A0' + UNITS[2];
    if (b >= 1024 ** 2) return n(b / 1024 ** 2, 0) + '\u00A0' + UNITS[1];
    return n(b / 1024, 0) + '\u00A0' + UNITS[0];
  }
  function date(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return new Date(iso).toDateString(); }
  }
  function country(cc) {
    if (!cc) return '';
    try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); const x = d.of(cc); if (x && x !== cc) return x; } catch (e) {}
    return cc;
  }

  window.CGI18n = { t, n, n2, size, date, country, lang, dir: 'ltr' };
})();
