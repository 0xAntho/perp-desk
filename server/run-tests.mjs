// Runs every server/**/*.test.ts. Lists the files itself: Windows shells don't expand globs and Node 20 can't either.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = readdirSync('server', { recursive: true }).filter(f => f.endsWith('.test.ts')).map(f => join('server', f));
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
