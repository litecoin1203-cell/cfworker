// Turns a daily backup file (cloudgold-backup-YYYY-MM-DD.json, sent to the owner's Telegram by sendBackup) into
// SQL that loads it into a NEW, empty D1 database on which every migration has already run (OPS-06).
//
//   node scripts/restore-backup.mjs cloudgold-backup-2026-11-14.json > restore.sql
//   npx wrangler d1 execute <new-database> --remote --file restore.sql
//
// The full runbook (and what a backup cannot bring back) is docs/RESTORE.md. This runs on the owner's computer,
// never in the Worker, and only reads the file it is given.
//
// The backup leaves out what must not sit in a chat, so after a restore:
//   - users.password_hash is a hash no password matches (the one Telegram-only accounts already have): people
//     sign in with Telegram, or the owner sets a new password for them in the bot (the user's screen, 🔑 button).
//   - subscriptions.sub_url, panel_accounts.sub_path / last_error come back empty. The Worker serves configs only
//     for accounts with a sub_path, and a sync does not refill it for an account that still exists on the panel,
//     so the VPN links need re-linking (see docs/RESTORE.md). That is why D1 Time Travel comes first.
//   - panel logins (panel_cred_*), the SMS key and other secret settings are not in it: enter them again in the bot.
//   - admin_audit rows come back without their undo data.
import { readFileSync } from 'node:fs';

// The tables backupJson writes, in an order that also suits a database with foreign keys (parents first).
export const BACKUP_TABLES = ['users', 'plans', 'subscriptions', 'orders', 'wallet_tx', 'devices', 'settings', 'coupons',
  'coupon_uses', 'panels', 'panel_accounts', 'sub_periods', 'usage_counters', 'admin_audit'];

// What a column the backup leaves out gets back, where the schema has no default for it.
export const NO_PASSWORD = `pbkdf2$5000$${'0'.repeat(32)}$${'0'.repeat(64)}`;
const FILL = { users: { password_hash: NO_PASSWORD } };

const ident = (s) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`not a column name: ${JSON.stringify(s)}`);
  return `"${s}"`;
};

export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'object') v = JSON.stringify(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The SQL for one backup (the parsed JSON or its text), and how many rows each table gets.
export function restoreSql(backup) {
  const b = typeof backup === 'string' ? JSON.parse(backup) : backup;
  if (!b || typeof b !== 'object' || !b.tables || typeof b.tables !== 'object') throw new Error('not a Cloud Gold backup: no "tables"');
  const unknown = Object.keys(b.tables).filter((t) => !BACKUP_TABLES.includes(t));
  if (unknown.length) throw new Error(`unknown tables in the backup: ${unknown.join(', ')}`);
  if (!Array.isArray(b.tables.users)) throw new Error('not a Cloud Gold backup: no users table');
  const lines = [`-- Cloud Gold restore of the backup made at ${String(b.created_at || '?').replace(/[\r\n]/g, ' ')}`,
    '-- For a new database with every migration applied. Rows the migrations seeded are replaced by the backup.',
    '-- WARNING: this first DELETEs every row of each backed-up table. Never run it against the live database.'];
  const counts = {};
  for (const t of BACKUP_TABLES) {
    const rows = b.tables[t];
    if (!Array.isArray(rows)) continue;
    lines.push(`DELETE FROM ${ident(t)};`);
    for (const row of rows) {
      const r = { ...(FILL[t] || {}), ...row };
      const cols = Object.keys(r);
      lines.push(`INSERT INTO ${ident(t)} (${cols.map(ident).join(', ')}) VALUES (${cols.map((c) => sqlValue(r[c])).join(', ')});`);
    }
    counts[t] = rows.length;
  }
  return { sql: lines.join('\n') + '\n', counts };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/restore-backup.mjs <cloudgold-backup.json> > restore.sql'); process.exit(2); }
  const { sql, counts } = restoreSql(readFileSync(file, 'utf8'));
  process.stdout.write(sql);
  console.error(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', '));
}
