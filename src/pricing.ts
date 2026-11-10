/** Estimated USD cost of one Messages response, from Anthropic's published prices. The price table refreshes itself
 * once a day from Anthropic's pricing page (its markdown version; no API credit needed). If the page can't be read
 * or its numbers don't look right, the last good table stays in use; the built-in copy below is the fallback. */
import type { Env } from './shared';
import type { Usage } from './usage';

/** USD per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output. */
type Prices = number[];
/** Prices for prompts over `over` tokens (0 = all prompts); Claude Haiku 5.5 charges more above 100,000. */
interface Tier { over: number; p: Prices }
type PriceTable = Record<string, Tier[]>;

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const PRICE_RELOAD_MS = 60 * 60_000; // each instance re-reads the stored table at most hourly
const PRICE_FETCH_MS = 24 * 3_600_000; // the pricing page is read at most daily

// From the pricing page on 2026-10-28.
const BUILT_IN: PriceTable = {
  'claude-fable-5-1': [{ over: 0, p: [10, 12.5, 20, 0.25, 50] }],
  'claude-mythos-5-1': [{ over: 0, p: [10, 12.5, 20, 0.25, 50] }],
  'claude-fable-5': [{ over: 0, p: [10, 12.5, 20, 1, 50] }],
  'claude-opus-5-5': [{ over: 0, p: [4, 5, 8, 0.2, 20] }],
  'claude-opus-5': [{ over: 0, p: [5, 6.25, 10, 0.5, 25] }],
  'claude-opus-4-8': [{ over: 0, p: [5, 6.25, 10, 0.5, 25] }],
  'claude-opus-4-7': [{ over: 0, p: [5, 6.25, 10, 0.5, 25] }],
  'claude-opus-4-6': [{ over: 0, p: [5, 6.25, 10, 0.5, 25] }],
  'claude-sonnet-5-5': [{ over: 0, p: [2, 2.5, 4, 0.1, 10] }],
  'claude-sonnet-5': [{ over: 0, p: [2, 2.5, 4, 0.2, 10] }],
  'claude-sonnet-4-6': [{ over: 0, p: [3, 3.75, 6, 0.3, 15] }],
  'claude-haiku-5-5': [{ over: 0, p: [0.1, 0.125, 0.2, 0.01, 0.5] }, { over: 100_000, p: [0.5, 0.625, 1, 0.05, 2.5] }],
  'claude-haiku-4-5': [{ over: 0, p: [1, 1.25, 2, 0.1, 5] }],
};

// Per instance: the table in use and where it came from.
export const priceState = {
  table: null as PriceTable | null, // null = built-in
  fetchedAt: null as string | null, // when the pricing page was last read successfully
  checkedAt: null as string | null, // when it was last attempted
  error: null as string | null, // why the last attempt failed, if it did
};
let nextPriceCheck = 0;

const table = (): PriceTable => priceState.table ?? BUILT_IN;
/** Longest matching model-ID prefix wins (claude-opus-5-5 over claude-opus-5). */
function lookup(model: string): Tier[] | null {
  const t = table();
  const match = Object.keys(t).filter((id) => model.startsWith(id)).sort((a, b) => b.length - a.length)[0];
  return match ? t[match] : null;
}

/** Base prices for a model ID (input, 5m cache write, 1h cache write, cache read, output), or null if unknown. */
export function priceFor(model: string): number[] | null {
  return lookup(model)?.find((tier) => tier.over === 0)?.p ?? null;
}

interface RawUsage {
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string;
  inference_geo?: string;
  server_tool_use?: { web_search_requests?: number };
}

/** null when the model is not in the price table. */
export function estimateCost(u: Usage): number | null {
  const tiers = u.model ? lookup(u.model) : null;
  if (!tiers) return null;
  const raw = (u.raw ?? {}) as RawUsage;
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const p = [...tiers].sort((a, b) => b.over - a.over).find((tier) => prompt > tier.over || tier.over === 0)!.p;
  const write1h = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = raw.cache_creation ? raw.cache_creation.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens;
  let cost = (u.input_tokens * p[0] + write5m * p[1] + write1h * p[2] + u.cache_read_input_tokens * p[3] + u.output_tokens * p[4]) / 1e6;
  if (raw.speed === 'fast') cost *= 2; // Fast mode: 2x on these models.
  if (raw.inference_geo === 'us') cost *= 1.1; // US-only inference.
  cost += (raw.server_tool_use?.web_search_requests ?? 0) * 0.01; // $10 per 1,000 searches.
  return Math.round(cost * 1e6) / 1e6;
}

/** Reads the "Model pricing" table of the pricing page's markdown: one row per model, e.g.
 * "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |". */
export function parsePricing(markdown: string): PriceTable | null {
  const start = markdown.indexOf('## Model pricing');
  if (start < 0) return null;
  const end = markdown.indexOf('\n## ', start + 3);
  const parsed: PriceTable = {};
  for (const line of markdown.slice(start, end > 0 ? end : undefined).split('\n')) {
    if (!line.startsWith('| Claude')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    // "Claude Haiku 5.5 (for prompts over 100,000 tokens)", "Claude Mythos 5.1 ([limited availability](https://...))"
    let name = cells[0].replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/<[^>]+>/g, '');
    const over = /over ([\d,]+) tokens/i.exec(name);
    name = name.replace(/\([^)]*\)/g, '').trim();
    const id = `claude-${name.replace(/^Claude\s+/i, '').toLowerCase().replace(/[.\s]+/g, '-')}`;
    const p = cells.slice(1, 6).map((c) => Number(/\$\s*([\d.]+)/.exec(c)?.[1]));
    if (!/^claude-[a-z]+(-\d+)+$/.test(id) || p.some((n) => !Number.isFinite(n) || n <= 0)) continue;
    (parsed[id] ??= []).push({ over: over ? Number(over[1].replace(/,/g, '')) : 0, p });
  }
  return parsed;
}

/** Sanity checks before a parsed table replaces the one in use. */
export function plausible(t: PriceTable | null): t is PriceTable {
  if (!t || Object.keys(t).length < 6) return false;
  for (const tiers of Object.values(t)) {
    if (!tiers.some((tier) => tier.over === 0)) return false;
    for (const { p: [input, write5m, write1h, read, output] } of tiers) {
      if (!(read < input && input < write5m && write5m <= write1h && input < output && output < 1000)) return false;
    }
  }
  return true;
}

/** Keeps this instance's price table current: re-reads the stored table hourly and, when the stored copy is a
 * day old, reads Anthropic's pricing page and stores the new table if it passes the checks. */
export async function maybeUpdatePrices(env: Env, now: number): Promise<void> {
  const db = env.USAGE_DB;
  if (!db || now < nextPriceCheck) return;
  nextPriceCheck = now + PRICE_RELOAD_MS;
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE name = 'prices'`).first<{ value: string }>();
    if (row) Object.assign(priceState, JSON.parse(row.value));
    if (priceState.checkedAt && now - Date.parse(priceState.checkedAt) < PRICE_FETCH_MS) return;
    let status = 0;
    let parsed: PriceTable | null = null;
    try {
      const r = await fetch(PRICING_URL, { headers: { accept: 'text/markdown' } });
      status = r.status;
      parsed = r.ok ? parsePricing(await r.text()) : null;
    } catch {
      // status stays 0
    }
    const checkedAt = new Date(now).toISOString();
    if (plausible(parsed)) {
      Object.assign(priceState, { table: parsed, fetchedAt: checkedAt, checkedAt, error: null });
    } else {
      // Keep the table in use; say why on the dashboard. Tried again in a day.
      Object.assign(priceState, { checkedAt, error: status === 200 ? 'the price table on the page looked different than expected' : `the pricing page could not be loaded (${status || 'network error'})` });
    }
    await db.prepare(`INSERT INTO settings (name, value, updated_at) VALUES ('prices', ?1, ?2)
        ON CONFLICT (name) DO UPDATE SET value = ?1, updated_at = ?2`)
      .bind(JSON.stringify(priceState), checkedAt).run();
  } catch {
    // Best effort: the current table stays in use.
  }
}
