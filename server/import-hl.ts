// One-time import of Hyperliquid's trade-history CSV: `npm run import:hl data/hl_history.csv`
// Only rows older than the oldest fill already fetched from the API are added, so the two never
// overlap. Run the server once first (to fetch what the API serves), then import, then restart it.
import { readFileSync } from 'node:fs';
import { importable, parseHlCsv } from './hl-csv.js';
import { DB_PATH, Store } from './store.js';

try { process.loadEnvFile('.env'); } catch { /* no .env */ }
const file = process.argv[2];
const user = process.env.HL_ADDRESS?.trim().toLowerCase();
if (!file || !user) {
  console.error('Usage: npm run import:hl <csv file>   (HL_ADDRESS must be set in .env)');
  process.exit(1);
}
const store = new Store(DB_PATH);
const apiOldest = store.oldestTrade('hyperliquid', user, '%:csv:%');
if (apiOldest == null) {
  console.error('No Hyperliquid history in the database yet: start the server once, then import.');
  process.exit(1);
}
const all = parseHlCsv(readFileSync(file, 'utf8'), user);
const rows = importable(all, apiOldest);
store.saveTrades(rows);
store.close();
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
console.log(rows.length
  ? `Imported ${rows.length} of ${all.length} perp fills (${day(rows[0].ts)} → ${day(rows[rows.length - 1].ts)}); the rest is already covered by the API. Restart the server to see them.`
  : `Nothing to import: the API history already reaches back to ${day(apiOldest)}.`);
