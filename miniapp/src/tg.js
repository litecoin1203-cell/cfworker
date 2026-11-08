// A thin layer over Telegram's Mini App API. Everything here also works when telegram-web-app.js did not load
// (telegram.org can be slow or filtered): initData, platform and theme are read from the URL hash Telegram adds.
const hash = new URLSearchParams(String(location.hash || '').slice(1));

export const webApp = () => (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) || null;

// the signed sign-in data; '' when the page was not opened from Telegram
export function initData() {
  const w = webApp();
  return (w && w.initData) || hash.get('tgWebAppData') || '';
}

function themeParams() {
  const w = webApp();
  if (w && w.themeParams && w.themeParams.bg_color) return w.themeParams;
  try { return JSON.parse(hash.get('tgWebAppThemeParams') || '{}'); } catch (e) { return {}; }
}

// Night when Telegram says dark (or, outside Telegram, when the phone does). Colours are always Pleat's own.
export function isNight() {
  const w = webApp();
  if (w && w.colorScheme) return w.colorScheme === 'dark';
  const bg = themeParams().bg_color;
  if (/^#[0-9a-f]{6}$/i.test(bg || '')) {
    const c = parseInt(bg.slice(1), 16);
    return ((c >> 16) & 255) * 0.299 + ((c >> 8) & 255) * 0.587 + (c & 255) * 0.114 < 128;
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

const GROUND = { day: '#E7F1FA', night: '#04080F' };

// applies day/night to the page and to Telegram's own header and background, so no seam shows
export function applyTheme() {
  const night = isNight();
  document.documentElement.classList.toggle('night', night);
  const w = webApp();
  const c = night ? GROUND.night : GROUND.day;
  try { if (w && w.setHeaderColor) w.setHeaderColor(c); if (w && w.setBackgroundColor) w.setBackgroundColor(c); } catch (e) { /* older clients */ }
  return night;
}

// waits a little for telegram-web-app.js (it loads async), then tells Telegram the page is ready
export async function ready(maxMs = 2500) {
  const t0 = Date.now();
  while (!webApp() && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100));
  const w = webApp();
  applyTheme();
  if (w) {
    try { w.ready(); w.expand(); w.onEvent && w.onEvent('themeChanged', applyTheme); } catch (e) { /* ignore */ }
  }
  return !!w;
}

export function haptic(kind = 'light') {
  try { const h = webApp() && webApp().HapticFeedback; if (h) kind === 'success' || kind === 'error' ? h.notificationOccurred(kind) : h.impactOccurred(kind); } catch (e) { /* ignore */ }
}

export const platform = () => (webApp() && webApp().platform) || hash.get('tgWebAppPlatform') || '';
