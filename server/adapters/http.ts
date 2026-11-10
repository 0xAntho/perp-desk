// Small helpers shared by the real adapters.

export type Fetch = typeof fetch;
export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Fetch that backs off on 429: the server's Retry-After (whole seconds), else 1 s, 2 s, 4 s… `init` is rebuilt per attempt. */
export async function fetchRetry(fetchImpl: Fetch, url: string, init: () => RequestInit = () => ({}), retries = 5): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetchImpl(url, { ...init(), signal: AbortSignal.timeout(15_000) });
    if (r.status !== 429 || i >= retries) return r;
    await sleep((Number(r.headers.get('retry-after')) || 2 ** i) * 1000);
  }
}

/** Normalized 0x wallet address and its short UI label; throws naming the env variable when malformed. */
export function wallet(address: string, envName: string) {
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`${envName} is not a valid 0x wallet address`);
  return { address: a, label: a.slice(0, 6) + '…' + a.slice(-4) };
}

/** 'BTC-USD' → 'BTC' (Arcus, Extended market names). */
export const symbolOf = (market: string) => market.replace(/-USD$/, '');
