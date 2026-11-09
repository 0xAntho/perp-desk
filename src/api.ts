// Backend client + TanStack Query hooks (Implementation Plan §6).
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { ExchangeId, Position, Trade } from '../server/types';

export type { ExchangeId, Position, Trade };
export type Tab = 'all' | ExchangeId;
export type Range = '24h' | '7D' | '30D' | 'All';
export type Status = 'loading' | 'live' | 'stale' | 'error';

export interface ExchangeSummary {
  id: ExchangeId; name: string; label: string; mock: boolean; status: Status; error: string | null;
  updatedAt: number | null; balance: number; freeCollateral: number; upnl: number;
}
export interface Summary { balance: number; upnl: number; updatedAt: number | null; exchanges: ExchangeSummary[] }
export interface Pnl {
  range: Range; from: number; to: number; points: number[];
  series: { id: ExchangeId; name: string; vals: number[] }[];
  flows: { gross: number; fees: number; funding: number; net: number };
}
export type TopTrade = Trade & { net: number };   // realized PnL minus the order's fees
export interface TopTrades { best: TopTrade[]; worst: TopTrade[] }
export interface ActivityDay { date: string; count: number }

async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const r = await fetch(`/api/${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const FAST = 15_000, SLOW = 60_000;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const useSummary = (exchange: Tab) =>
  useQuery({ queryKey: ['summary', exchange], queryFn: () => get<Summary>('summary', { exchange }), refetchInterval: FAST });
export const usePositions = (exchange: Tab) =>
  useQuery({ queryKey: ['positions', exchange], queryFn: () => get<Position[]>('positions', { exchange }), refetchInterval: FAST });
export const usePnl = (exchange: Tab, range: Range) =>
  useQuery({ queryKey: ['pnl', exchange, range], queryFn: () => get<Pnl>('pnl', { exchange, range }), refetchInterval: SLOW });
export const useTopTrades = (exchange: Tab, range: Range) =>
  useQuery({ queryKey: ['top', exchange, range], queryFn: () => get<TopTrades>('trades/top', { exchange, range, n: 5 }), refetchInterval: SLOW });
export const useActivity = (exchange: Tab, weeks: number) =>
  useQuery({ queryKey: ['activity', exchange, weeks], queryFn: () => get<ActivityDay[]>('activity', { exchange, weeks, tz: TZ }), refetchInterval: SLOW });

/** Asks the backend to re-sync every exchange now, then refetches everything. */
export function useRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => { const r = await fetch('/api/refresh', { method: 'POST' }); if (!r.ok) throw new Error('refresh failed'); },
    onSettled: () => qc.invalidateQueries(),
  });
}
