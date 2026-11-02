import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { HyperliquidAdapter } from './adapters/hyperliquid.js';
import { MockAdapter } from './adapters/mock.js';
import { createApp } from './app.js';
import { Sync } from './sync.js';
import type { Adapter } from './types.js';

try { process.loadEnvFile('.env'); } catch { /* no .env: rely on the real environment */ }

const env = process.env;
const PORT = Number(env.PORT) || 8787;
const HOST = env.HOST || '127.0.0.1';   // local only by default: your positions are private

const adapters: Adapter[] = [];
if (env.HL_ADDRESS) {
  adapters.push(new HyperliquidAdapter(env.HL_ADDRESS));
} else {
  console.warn('HL_ADDRESS not set: Hyperliquid runs on mock data. Add it to .env.');
  adapters.push(new MockAdapter('hyperliquid', 'Hyperliquid', 48210, 7, 11, { symbols: 8 }));
}
// Not wired up yet — swap each for a real adapter (Plan §3, §8).
adapters.push(
  new MockAdapter('perpl', 'Perpl', 21540, 4, 23),
  new MockAdapter('arcus', 'Arcus', 15890, 3, 37, { noLiq: true }),
  new MockAdapter('extended', 'Extended', 9320, 2.5, 51),
);

const sync = new Sync(adapters);
sync.start();

const auth = env.DASH_USER && env.DASH_PASS ? { username: env.DASH_USER, password: env.DASH_PASS } : undefined;
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !auth) {
  console.warn('Listening beyond localhost without DASH_USER/DASH_PASS: anyone on the network can see your positions.');
}
const app = createApp(sync, { auth });

// In production the API also serves the built dashboard.
if (env.NODE_ENV === 'production' && existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, info => {
  console.log(`Perp desk API on http://${HOST}:${info.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { sync.stop(); process.exit(0); });
