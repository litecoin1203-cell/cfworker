// Pleat's in-app update. There is no store: the "Pleat Flutter app" workflow builds one APK per phone type
// (arm64-v8a, armeabi-v7a, x86_64) and puts them on the repo's release `pleat-latest`. The repo is PUBLIC (since
// 2026-11-11), so that release and every Actions log can be read by anyone: never put anything in an APK or a log
// that must stay secret. Phones in Iran often can't reach GitHub, so this Worker reads the release (with the
// read-only token PLEAT_DL_TOKEN when set, copied there by the deploy workflow: it lifts GitHub's per-IP rate
// limit and keeps working if the repo is ever made private again) and passes the file through.
//
// Nothing reaches the users until the admin taps "announce" in the bot: that copies the newest build (version,
// build number, and per phone type the asset id, size and SHA-256 GitHub gives) into the setting `app_release`,
// which app-config hands to every app. The app downloads the file for its own phone type (signed-in users only),
// resumes a dropped download with a Range request, checks the SHA-256 and opens Android's installer.
//
// Free plan: reading the release is one subrequest; a download is two (the asset, then GitHub's signed file
// address it redirects to), and the body is streamed through untouched, so it costs almost no CPU.
import { err, nowSec, deadline } from './util.js';
import { getSetting, setSetting } from './db.js';

export const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
export const ABI_FA = { 'arm64-v8a': 'arm64', 'armeabi-v7a': 'arm32', 'x86_64': 'x86_64' };
const RELEASE_TAG = 'pleat-latest';
const SHA = /^[0-9a-f]{64}$/;
const UA = 'cloudgold-worker';

const repoOf = (env) => (/^[\w.-]+\/[\w.-]+$/.test(env.PLEAT_REPO || '') ? env.PLEAT_REPO : 'litecoin1203-cell/cfworker');
const ghHeaders = (env, accept) => ({ authorization: 'Bearer ' + env.PLEAT_DL_TOKEN, accept, 'user-agent': UA, 'x-github-api-version': '2022-11-28' });

// ---- What's new: a few short lines per build, shown in Pleat's update sheet ----
// The lines come from flutter_vpn/assets/whats_new/whats_new.json (the same file the app bundles for its own
// "What's new" page): the APK workflow copies the entry of the built version into the release's notes as
// "- NEW: ...", "- BETTER: ...", "- FIXED: ...". The admin can replace them in the bot before or after announcing.
// Pleat's UI is English only, so a line in another script is refused.
export const NOTE_KINDS = ['new', 'better', 'fixed'];
export const NOTE_FA = { new: '✨ جدید', better: '⚡ بهتر', fixed: '🛠 رفع مشکل' };
const NOTE_MAX = 8, NOTE_LEN = 160;
const NOTE_LINE = /^\s*(?:[-*•]\s*)?(new|better|fixed|fix)\s*[:·\-–]\s*(.+)$/i;
const NON_LATIN = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

// what a stored or announced list may hold: known kinds, plain short text, at most NOTE_MAX lines
export function cleanNotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const kind = NOTE_KINDS.includes(n.kind) ? n.kind : 'new';
    const text = String(n.text || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_LEN);
    if (text && !NON_LATIN.test(text)) out.push({ kind, text });
    if (out.length >= NOTE_MAX) break;
  }
  return out;
}

// The admin's message (one item per line, "NEW: ..." / "BETTER: ..." / "FIXED: ..." or a plain line = new).
// strict: the release body, where only tagged "- KIND: text" lines count (the rest is the build note).
export function parseNotes(text, strict = false) {
  const notes = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = NOTE_LINE.exec(line);
    if (!m && strict) continue;
    const kind = m ? (m[1].toLowerCase() === 'fix' ? 'fixed' : m[1].toLowerCase()) : 'new';
    const body = (m ? m[2] : line.replace(/^[-*•]\s*/, '')).trim();
    if (!body) continue;
    if (NON_LATIN.test(body)) return { error: 'latin' };
    if (body.length > NOTE_LEN) return { error: 'long' };
    notes.push({ kind, text: body });
  }
  if (notes.length > NOTE_MAX) return { error: 'many' };
  return { notes: cleanNotes(notes) };
}

// the notes as the bot shows them to the admin
export const notesFa = (notes) => (notes && notes.length ? notes.map((n) => `${NOTE_FA[n.kind] || '•'} · ${n.text}`).join('\n') : '(بدون متن تغییرات)');

// A build as read from the release or as announced, with only the fields that are what they claim.
export function cleanRelease(m) {
  if (!m || typeof m !== 'object') return null;
  const build = parseInt(m.build, 10);
  const version = String(m.version || '');
  if (!(build > 0) || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const abis = {};
  for (const abi of ABIS) {
    const a = m.abis && m.abis[abi];
    if (!a) continue;
    const size = parseInt(a.size, 10), id = parseInt(a.id, 10);
    const sha256 = String(a.sha256 || '').toLowerCase();
    if (size > 0 && id > 0 && SHA.test(sha256)) abis[abi] = { size, sha256, id };
  }
  if (!Object.keys(abis).length) return null;
  // tag: one value per upload, so the app never mixes the bytes of two uploads of the same version
  const tag = `${build}-` + ABIS.filter((x) => abis[x]).map((x) => abis[x].id.toString(36)).join('.');
  return {
    version, build, tag, abis,
    commit: /^[0-9a-f]{7,40}$/.test(String(m.commit || '')) ? String(m.commit).slice(0, 7) : '',
    built_at: parseInt(m.built_at, 10) || 0,
    force: m.force === true,
    at: parseInt(m.at, 10) || 0,
    notes: cleanNotes(m.notes),
  };
}

// The release as GitHub describes it -> its newest build. The workflow names the files
// pleat-<version>-<build>-<abi>.apk and keeps the last few builds, so the announced one is still there after the
// next build; "built from <sha>" is in the release notes.
export function releaseFromGitHub(r) {
  if (!r || typeof r !== 'object') return null;
  const builds = {};
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    const m = /^pleat-(\d+\.\d+\.\d+)-(\d+)-(arm64-v8a|armeabi-v7a|x86_64)\.apk$/.exec(String(a.name || ''));
    const sha = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest || ''));
    if (!m || !sha || (a.state || 'uploaded') !== 'uploaded') continue;
    const b = (builds[m[2]] ||= { version: m[1], build: m[2], abis: {}, at: 0 });
    b.abis[m[3]] = { size: a.size, sha256: sha[1], id: a.id };
    b.at = Math.max(b.at, Date.parse(a.updated_at || a.created_at || '') || 0);
  }
  const top = Object.values(builds).sort((x, y) => y.build - x.build)[0];
  if (!top) return null;
  const commit = (/built from ([0-9a-f]{7,40})/.exec(String(r.body || '')) || [])[1] || '';
  // the What's new lines belong to the version the notes were written for (the newest build's)
  const said = /Pleat (\d+\.\d+\.\d+)\+/.exec(String(r.body || ''));
  const notes = !said || said[1] === top.version ? (parseNotes(r.body, true).notes || []) : [];
  return cleanRelease({ ...top, commit, notes, built_at: top.at > 0 ? Math.floor(top.at / 1000) : 0 });
}

// the newest build on the release; null without the token, before the first split build, or when GitHub is down
export async function latestBuild(env) {
  if (!env.PLEAT_DL_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repoOf(env)}/releases/tags/${RELEASE_TAG}`, { headers: ghHeaders(env, 'application/vnd.github+json'), signal: deadline(10000) });
    if (!res.ok) return null;
    return releaseFromGitHub(await res.json());
  } catch (e) { return null; }
}

// what the users are told about (set by the admin in the bot)
export async function announced(env, settings) {
  const raw = settings ? settings.app_release : await getSetting(env, 'app_release');
  if (!raw) return null;
  try { return cleanRelease(JSON.parse(raw)); } catch (e) { return null; }
}

// app-config's `update`: the announced build, what each phone type downloads (no GitHub ids), and whether it is a must
export function updateOut(rel) {
  if (!rel) return null;
  const abis = {};
  for (const [k, a] of Object.entries(rel.abis)) abis[k] = { size: a.size, sha256: a.sha256 };
  return { version: rel.version, build: rel.build, tag: rel.tag, force: rel.force, abis, notes: rel.notes || [] };
}

// GET /app/apk?tag=&abi= : the announced APK for one phone type, passed through from the release.
// A Range header (a resumed download) goes along, so the answer may be 206.
export async function apkDownload(env, request) {
  const q = new URL(request.url).searchParams;
  const rel = await announced(env);
  const a = rel && rel.abis[q.get('abi') || ''];
  // an app that asks for a build that is no longer announced gets 410 and reads app-config again
  if (!rel || q.get('tag') !== rel.tag) throw err(410, 'update_gone', 'این نسخه دیگر در دسترس نیست.');
  if (!a) throw err(404, 'not_found', 'پیدا نشد.');
  if (!env.PLEAT_DL_TOKEN) throw err(503, 'update_unavailable', 'فایل آپدیت در دسترس نیست.');
  const range = /^bytes=\d{1,10}-$/.test(request.headers.get('range') || '') ? request.headers.get('range') : '';
  // the asset answers with a redirect to a signed address that must not get the token, so it is followed by hand
  let meta;
  try { meta = await fetch(`https://api.github.com/repos/${repoOf(env)}/releases/assets/${a.id}`, { headers: ghHeaders(env, 'application/octet-stream'), redirect: 'manual', signal: deadline(10000) }); }
  catch (e) { throw err(503, 'update_unavailable', 'فایل آپدیت در دسترس نیست.'); } // GitHub did not answer in time
  let res = meta;
  const to = meta.headers.get('location');
  if (meta.status >= 300 && meta.status < 400 && to && /^https:\/\//.test(to)) {
    res = await fetch(to, { headers: { 'user-agent': UA, ...(range ? { range } : {}) } });
  }
  // the file was rebuilt or pruned since the announcement: gone until the admin announces again
  if (res.status === 404) throw err(410, 'update_gone', 'این نسخه دیگر در دسترس نیست.');
  if (res.status !== 200 && res.status !== 206) throw err(503, 'update_unavailable', 'فایل آپدیت در دسترس نیست.');
  const h = { 'content-type': 'application/vnd.android.package-archive', 'cache-control': 'private, no-store', 'accept-ranges': 'bytes' };
  for (const k of ['content-length', 'content-range']) { const v = res.headers.get(k); if (v) h[k] = v; }
  return new Response(res.body, { status: res.status, headers: h });
}

// The announce / force / withdraw buttons (admin-actions.js 'app.release').
export async function setRelease(env, op) {
  const before = await getSetting(env, 'app_release');
  const cur = await announced(env);
  let next;
  if (op === 'announce') {
    if (!env.PLEAT_DL_TOKEN) return { error: 'توکن دانلود (PLEAT_DL_TOKEN) هنوز به سرور داده نشده؛ اول آن را در GitHub بساز و «Deploy Cloud Gold server» را اجرا کن.' };
    const latest = await latestBuild(env);
    if (!latest) return { error: 'روی ریلیز pleat-latest بیلدی با فایل جدا برای هر گوشی پیدا نشد. اول workflow «Pleat Flutter app» را اجرا کن.' };
    if (cur && cur.tag === latest.tag) return { error: 'همین بیلد الان اعلام شده.' };
    if (cur && latest.build < cur.build) return { error: `این بیلد (${latest.build}) از اعلام‌شده (${cur.build}) قدیمی‌تر است.` };
    const draft = await notesDraft(env);
    next = { ...latest, notes: draft && draft.tag === latest.tag ? draft.notes : latest.notes, force: false, at: nowSec() };
  } else if (op === 'force') {
    if (!cur) return { error: 'هنوز نسخه‌ای اعلام نشده.' };
    next = { ...cur, force: !cur.force };
  } else if (op === 'withdraw') {
    if (!cur) return { error: 'هنوز نسخه‌ای اعلام نشده.' };
    next = null;
  } else return { error: 'دستور ناشناخته.' };
  await saveRelease(env, next);
  return { before, next };
}

export const saveRelease = (env, rel) => setSetting(env, 'app_release', rel ? JSON.stringify(rel) : '');

// The admin's own What's new lines for a build not announced yet ({tag, notes}); announce uses them.
export async function notesDraft(env) {
  try {
    const d = JSON.parse((await getSetting(env, 'app_notes_draft')) || 'null');
    return d && typeof d.tag === 'string' ? { tag: d.tag, notes: cleanNotes(d.notes) } : null;
  } catch (e) { return null; }
}

// Which build the What's new lines are for: the newest build when it is not announced yet, else the announced
// one (its lines change in the apps at once). latest: the newest build when the caller already read it.
export async function notesTarget(env, latest) {
  const cur = await announced(env);
  if (latest === undefined) latest = await latestBuild(env);
  if (latest && (!cur || latest.tag !== cur.tag) && (!cur || latest.build > cur.build)) {
    const d = await notesDraft(env);
    return { kind: 'draft', rel: latest, notes: d && d.tag === latest.tag ? d.notes : latest.notes };
  }
  if (cur) return { kind: 'announced', rel: cur, notes: cur.notes };
  return null;
}

// The bot's "write other lines" / "no lines" (admin-actions.js 'app.notes'). Returns what to undo.
export async function setNotes(env, notes) {
  const t = await notesTarget(env);
  if (!t) return { error: 'هنوز بیلدی برای نوشتن تغییرات نیست.' };
  const clean = cleanNotes(notes);
  if (t.kind === 'draft') {
    const before = await getSetting(env, 'app_notes_draft');
    await setSetting(env, 'app_notes_draft', JSON.stringify({ tag: t.rel.tag, notes: clean }));
    return { key: 'app_notes_draft', before, rel: t.rel, notes: clean, kind: t.kind };
  }
  const before = await getSetting(env, 'app_release');
  await saveRelease(env, { ...t.rel, notes: clean });
  return { key: 'app_release', before, rel: t.rel, notes: clean, kind: t.kind };
}

// every 10 minutes (from the 2-minute cron): tell the admin once about each new build on the release
export async function checkNewBuild(env, notify) {
  if (!env.PLEAT_DL_TOKEN) return false;
  const latest = await latestBuild(env);
  if (!latest) return false;
  if ((await getSetting(env, 'app_build_seen')) === latest.tag) return false;
  await setSetting(env, 'app_build_seen', latest.tag);
  const cur = await announced(env);
  if (cur && cur.tag === latest.tag) return false;
  await notify([`📲 نسخه‌ی جدید Pleat ساخته شد: ${latest.version} (بیلد ${latest.build})`,
    `حجم: ${sizes(latest)}`, '', '📝 تغییرات این نسخه (کاربرها همین را می‌بینند):', notesFa(latest.notes), '',
    'هنوز به کاربرها اعلام نشده. برای اعلام یا عوض کردن متن، دکمه‌ی زیر را بزن.'].join('\n'),
  { inline_keyboard: [[{ text: '📲 نسخه‌ی اپ', callback_data: 'm:upd' }]] });
  return true;
}

export const mb = (n) => (n / (1024 * 1024)).toFixed(1);
export const sizes = (rel) => ABIS.filter((x) => rel.abis[x]).map((x) => `${ABI_FA[x]} ${mb(rel.abis[x].size)} مگ`).join(' · ');
