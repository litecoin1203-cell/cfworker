// English words for the monitoring screens: Cloudflare monitoring (worker/src/cfmon.js) and Pleat's automatic
// health reports (worker/src/health.js). The Worker sends codes; the bot words them in Persian, the page here.
// miniapp/test/admin.test.js fails when the Worker gains a code with no English here.

// ---------------- Cloudflare ----------------
// why a part of Cloudflare's numbers could not be read (cfmon.gql's codes)
export const CF_ERROR = {
  no_token: 'No token on the server yet',
  no_account: 'Account id not found. Set CF_ACCOUNT_ID, or limit the token to one account.',
  timeout: 'Cloudflare took longer than 9 seconds',
  net: 'Could not reach the Cloudflare API',
  denied: 'Token refused: wrong, or missing Account Analytics: Read',
  bad_reply: 'Cloudflare gave an answer that could not be read',
  cf: 'Cloudflare said',
  no_access: 'The token cannot read this account',
};
export const cfError = (e) => (!e ? '' : e.code === 'cf' || e.code === 'bad_reply' ? `${CF_ERROR[e.code]}: ${e.detail || 'error'}` : CF_ERROR[e.code] || String(e.code || 'error'));

// how a request ended (Cloudflare's workersInvocationsAdaptive status)
export const CF_STATUS = {
  success: 'Success', clientDisconnected: 'Client went away', scriptThrewException: 'Code error', exceededCpu: 'Over 10 ms CPU',
  exceededResources: 'Over the resource cap', exceededMemory: 'Over memory', internalError: 'Cloudflare internal error', responseStreamDisconnected: 'Answer cut off',
  loadSheddingErrored: 'Cloudflare overloaded', unknown: 'Unknown',
};
// success is good, the client leaving is neutral, the rest are failures
export const CF_STATUS_TONE = { success: 'ok', clientDisconnected: 'muted', responseStreamDisconnected: 'muted' };
export const CAPACITY_BY = { requests: 'Worker requests', d1_writes: 'D1 writes' };
export const RUN_STATE = { running: 'Running', ok: 'Success', cancelled: 'Cancelled', failed: 'Failed' };
export const RUN_TONE = { running: 'info', ok: 'ok', cancelled: '', failed: 'bad' };

// the share of a daily allowance as a status: under 60% fine, 60-85% watch, above 85% near the cap
export const quotaTone = (p) => (p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'ok');
export const pctText = (p) => (p == null ? '—' : p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);
export function bytes(v) {
  if (v == null) return '—';
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(v / 1024)} KB`;
}
// "5 h 12 min"
export function span(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
// local clock time of a unix second (the admin's phone is in Tehran; Telegram's WebView knows the zone)
export const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ---------------- Pleat health reports ----------------
export const PRIO = { 1: 'Critical', 2: 'Important', 3: 'Medium', 4: 'Daily summaries' };
export const PRIO_TONE = { 1: 'bad', 2: 'warn', 3: 'info', 4: '' };
export const MODE = { all: 'Everything', p2: 'Critical and important only', off: 'Off' };
export const TYPE = {
  crash: 'App / core crash', killed: 'Android closed the VPN', no_exit: 'No server connected',
  connect_fail: 'Connect failed', drop: 'Dropped mid-connection', silent: 'Server not answering', unsupported: 'Unsupported config',
  loc_mismatch: 'Location mismatch', exit_iran: 'Exit inside Iran',
  battery: 'High battery use', slow_connect: 'Slow connect', api_down: 'App server unreachable', update_fail: 'Update failed',
  app_error: 'App error', daily: 'Daily summary',
};
export const CAUSE = {
  timeout: 'no answer', reset: 'cut by the network', refused: 'server refused', dns: 'DNS', offline: 'no internet', tls: 'TLS',
  reality: 'REALITY', account: 'account not on the server', path: 'path setting', config: 'unknown setting', unknown: 'unknown',
  native: 'native (core) crash', java: 'app crash', dart: 'Dart error', anr: 'not responding (ANR)', low_memory: 'low memory', excessive: 'excessive use',
  signaled: 'system signal', unclean: 'sudden close', permission: 'VPN permission', other: 'other',
  download: 'download', verify: 'file check', install: 'install',
};
export const DETAIL = {
  proto: 'Protocol', ms: 'Time (ms)', s: 'Seconds', err: 'Core error', kind: 'Kind', tunnel: 'Tunnel was up', trace: 'Trace', reason: 'Reason',
  min: 'Minutes', rate: 'Battery % per hour', drop: 'Battery drop %', off: 'Screen off %', opt: 'Battery optimisation on', route: 'Route',
  tried: 'Tried', bridge: 'Bridge', stage: 'Stage', expected: 'Expected country', actual: 'Real country', misses: 'Missed pings',
  sessions: 'Sessions', ok: 'Succeeded', fail: 'Failed', minutes: 'Minutes connected', moved: 'Network changed', status: 'Code', what: 'Android says',
  sig: 'Signal', go: 'Core panic (Go)', abort: 'Abort message', cause: 'Cause', thread: 'Thread', lib: 'Library', frames: 'Frames',
  op: 'Tunnel was', up_s: 'Seconds connected', tomb: 'Android tombstone', stderr: 'Core stderr', pss: 'App memory (MB)', earlier: 'Earlier crash, read again',
};
// ApplicationExitInfo.REASON_* (Android 11+)
export const EXIT_REASON = {
  0: 'unknown', 1: 'the app closed itself', 2: 'system signal', 3: 'low memory (LMK)', 4: 'app crash (Java/Kotlin)', 5: 'native crash (core / C / Go library)',
  6: 'not responding (ANR)', 7: 'failed to start', 8: 'permission changed', 9: 'excessive use', 10: 'user closed it', 11: 'user stopped it', 12: 'a dependency died',
  13: 'other', 14: 'freezer', 15: 'package changed', 16: 'app updated',
};
export const SIGNAL = {
  6: 'SIGABRT: deliberate abort (Go core panic, or fdsan / libc)', 11: 'SIGSEGV: invalid memory access', 7: 'SIGBUS: memory error',
  4: 'SIGILL: invalid instruction', 5: 'SIGTRAP: trap / assert', 8: 'SIGFPE: arithmetic error', 9: 'SIGKILL: killed', 31: 'SIGSYS: forbidden syscall',
};
export const OP = { starting: 'connecting', up: 'connected', stopping: 'disconnecting', off: 'off' };
export const NET = { wifi: 'Wi-Fi', cell: 'mobile data', other: 'other' };
// health.crashKind: what a native crash most likely was, from what the phone sent
export const CRASH = {
  go_panic: 'The Xray core (Go code) panicked; its text is under "Core panic". Check "Protocol" to see whether it is tied to a server.',
  fdsan: 'A file descriptor was closed twice (fdsan): an app bug in closing the tun or a socket, not the server.',
  hev: 'Crash in the tunnel layer (hev-socks5-tunnel), not the Xray core.',
  xray_lib: 'Crash in the Xray core (Go library).',
  flutter: 'Crash in the app\'s display engine (Flutter), not the core or the server.',
  c_abort: 'A C library aborted by itself; "Abort message" says why.',
  not_go: 'Not a Go core panic: Go writes to stderr before every panic and wrote nothing this time. The source must be fdsan/libc, the tunnel layer (hev) or Flutter.',
  earlier: 'An older crash (from before an update) read again, but Android did not keep its details. The next crash on 1.2.38+ brings the panic text, library and server.',
  no_tombstone: 'Android kept no tombstone for this crash; if it were a Go core panic, "Core panic" would be filled in, and it is not.',
  sigabrt: 'Deliberate abort: a Go core (Xray) panic, fdsan/libc, or Flutter. This app version sent no more; from Pleat 1.2.38 the panic text, library and protocol come too.',
  sigsegv: 'Invalid memory access in native (C) code; Go code turns such an error into a panic and SIGABRT.',
};

// a value in words where the phone sends a number or a code word
export function detailValue(k, v, d) {
  if (k === 'reason' && EXIT_REASON[v] !== undefined) return `${v} = ${EXIT_REASON[v]}`;
  if (k === 'status' && d.reason === 5 && SIGNAL[v]) return `${v} = ${SIGNAL[v]}`;
  if (k === 'status' && d.reason === 2 && SIGNAL[v]) return `${v} = ${SIGNAL[v].split(':')[0]}`;
  if (k === 'op' && OP[v]) return OP[v];
  if (k === 'stderr' && /^quiet/.test(String(v))) return `${v} (the Go core wrote nothing)`;
  if (k === 'stderr' && /^not captured/.test(String(v))) return `${v} (was not captured)`;
  if (k === 'tomb' && v === 'none') return 'none (Android kept nothing)';
  if (k === 'tomb' && /^error/.test(String(v))) return `${v} (reading it failed)`;
  if (k === 'tomb' && /unread/.test(String(v))) return `${v} (there, but Pleat could not read it)`;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? Object.entries(x).map(([a, b]) => `${a}=${b}`).join(' ') : x)).join(' | ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

// one problem in a few words: what happened, on which server, why
export function problemTitle(r) {
  const cause = r.cause ? (r.type === 'loc_mismatch' && r.cause.includes('>') ? r.cause.replace('>', ' → ') : CAUSE[r.cause] || r.cause) : '';
  return [TYPE[r.type] || r.type, cause].filter(Boolean).join(' · ');
}
export const problemServer = (r) => r.exit_name || r.exit_key || '';
