// One-time import of Variational's trade-history CSV (no API yet): `npm run import:variational data/export-trades.csv`
// Re-importing a newer export recomputes and replaces every row (PnL depends on the whole fill history).
import { readFileSync } from 'node:fs';
import { parseVariationalCsv } from './variational-csv.js';
import { DB_PATH, Store } from './store.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import:variational <csv file>');
  process.exit(1);
}
const rows = parseVariationalCsv(readFileSync(file, 'utf8'));
const store = new Store(DB_PATH);
store.saveTrades(rows);
store.close();
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const pnl = rows.reduce((s, t) => s + t.realizedPnl, 0);
console.log(rows.length
  ? `Imported ${rows.length} fills (${day(rows[0].ts)} → ${day(rows[rows.length - 1].ts)}), realized PnL ${pnl.toFixed(2)}. Restart the server to see them.`
  : 'Nothing to import: no confirmed fills in the file.');
