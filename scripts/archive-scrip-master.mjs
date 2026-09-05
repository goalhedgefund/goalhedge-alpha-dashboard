/**
 * Snapshot today's Dhan scrip master into the dated archive.
 *
 * The live master is point-in-time: Dhan purges expired contracts from it. A
 * recording can therefore only be replayed against a master captured while its
 * contracts were still listed. Without a dated archive, every recording becomes
 * unreplayable one expiry cycle after it is made — which is exactly what
 * happened to the July 2026 corpus.
 *
 * Idempotent: re-running on the same day is a no-op.
 *
 * Usage: node scripts/archive-scrip-master.mjs [sourcePath]
 *        (defaults to $DHAN_SCRIP_MASTER_PATH, then the standard location)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCALPER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = join(SCALPER_ROOT, 'data', 'dhan', 'scrip-master');
const DEFAULT_SRC = 'D:\\DHAN_LOGIN\\api-scrip-master.csv';

const src = process.argv[2] ?? process.env.DHAN_SCRIP_MASTER_PATH?.trim() ?? DEFAULT_SRC;
if (!existsSync(src)) {
  console.error(`[archive-scrip-master] source not found: ${src}`);
  process.exit(1);
}

// Date the snapshot by the file's own mtime, not "today": if the master was
// last refreshed days ago, that earlier date is what it actually represents.
const stamp = new Date(statSync(src).mtime.getTime() - new Date().getTimezoneOffset() * 60_000)
  .toISOString()
  .slice(0, 10);

mkdirSync(ARCHIVE_DIR, { recursive: true });
const dest = join(ARCHIVE_DIR, `api-scrip-master-${stamp}.csv`);

if (existsSync(dest)) {
  console.log(`[archive-scrip-master] already archived: ${dest}`);
} else {
  copyFileSync(src, dest);
  const mb = (statSync(dest).size / 1e6).toFixed(1);
  console.log(`[archive-scrip-master] archived ${stamp} (${mb} MB) -> ${dest}`);
}

const have = readdirSync(ARCHIVE_DIR)
  .filter((f) => /^api-scrip-master-\d{4}-\d{2}-\d{2}\.csv$/.test(f))
  .sort();
console.log(`[archive-scrip-master] ${have.length} snapshot(s): ${have.join(', ')}`);
