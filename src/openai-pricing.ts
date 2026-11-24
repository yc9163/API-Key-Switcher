/** Estimated USD cost of one OpenAI response, from OpenAI's published prices. Like the Claude table, it refreshes
 * itself once a day from OpenAI's pricing page (its markdown version), keeps the last good table when the page
 * can't be read or looks wrong, and falls back to the built-in copy below. */
import type { Env } from './shared';
import type { Usage } from './usage';

/** USD per million tokens: input, output, cached input, 30-minute cache write, 12-hour cache write, then the same
 * five for prompts over the long-context threshold when the model has a long-context price. null = not listed. */
type Row = (number | null)[];
/** Price rows per processing tier (the response's `service_tier`), each keyed by model ID. */
interface OpenAITable { longOver: number; tiers: Record<string, Record<string, Row>> }

export const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md';
const PRICE_RELOAD_MS = 60 * 60_000;
const PRICE_FETCH_MS = 24 * 3_600_000;
// The tiers the gateway can price, and the pricing-page sections they come from.
const SECTIONS: Record<string, string[]> = {
  standard: ['Standard pricing data'],
  flex: ['Flex pricing data'],
  fast: ['Fast pricing data'],
  ultrafast: ['Ultrafast pricing data', 'Ultrafast promotion pricing data'],
};
// service_tier in a response -> pricing tier. "priority" is the former name of Fast mode.
const TIER_OF: Record<string, string> = { flex: 'flex', fast: 'fast', priority: 'fast', ultrafast: 'ultrafast' };

// Standard tier, from the pricing page on 2026-11-19.
const BUILT_IN: OpenAITable = {
  longOver: 272_000,
  tiers: {
    standard: {
      'gpt-6.2-astra': [8, 40, 0.4, 10, 20, 16, 60, 0.8, 20, 40],
      'gpt-6.2-sol': [2, 10, 0.1, 2.5, 5, 4, 15, 0.2, 5, 10],
      'gpt-6-astra': [10, 50, 1, 12.5, 25, 20, 75, 2, 25, 50],
      'gpt-6.1-sol': [2, 10, 0.1, 2.5, 5, 4, 15, 0.2, 5, 10],
      'gpt-6.1-terra': [1, 5, 0.05, 1.25, 2.5, 2, 7.5, 0.1, 2.5, 5],
      'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.25, 0.2, 0.75, 0.02, 0.25, 0.5],
      'gpt-6-sol': [2, 10, 0.2, 2.5, 5, 4, 15, 0.4, 5, 10],
      'gpt-5.6-sol': [4, 20, 0.4, 5, 10, 8, 30, 0.8, 10, 20],
      'gpt-5.6-terra': [2, 12, 0.2, 2.5, 5, 4, 18, 0.4, 5, 10],
      'gpt-5.6-luna': [0.2, 1.2, 0.02, 0.25, 0.5, 0.4, 1.8, 0.04, 0.5, 1],
      'gpt-5.5': [5, 30, 0.5, null, null, 10, 45, 1, null, null],
      'gpt-5.5-pro': [30, 180, null, null, null, 60, 270, null, null, null],
      'gpt-5.4': [2.5, 15, 0.25, null, null, 5, 22.5, 0.5, null, null],
      'gpt-5.4-pro': [30, 180, null, null, null, 60, 270, null, null, null],
      'gpt-5.4-mini': [0.75, 4.5, 0.075, null, null],
      'gpt-5.4-nano': [0.2, 1.25, 0.02, null, null],
      'gpt-5.2': [1.75, 14, 0.175, null, null],
      'gpt-5.2-pro': [21, 168, null, null, null],
      'gpt-5.1': [1.25, 10, 0.125, null, null],
      'gpt-5': [1.25, 10, 0.125, null, null],
      'gpt-5-mini': [0.25, 2, 0.025, null, null],
      'gpt-5-nano': [0.05, 0.4, 0.005, null, null],
      'gpt-5-pro': [15, 120, null, null, null],
      'gpt-4.1': [2, 8, 0.5, null, null],
      'gpt-4.1-mini': [0.4, 1.6, 0.1, null, null],
      'gpt-4o': [2.5, 10, 1.25, null, null],
      'gpt-4o-mini': [0.15, 0.6, 0.075, null, null],
      'o3-pro': [20, 80, null, null, null],
      'o3': [2, 8, 0.5, null, null],
      'text-embedding-3-small': [0.02, null, null, null, null],
      'text-embedding-3-large': [0.13, null, null, null, null],
      'text-embedding-ada-002': [0.1, null, null, null, null],
    },
  },
};

export const openaiPriceState = {
  table: null as OpenAITable | null, // null = built-in
  fetchedAt: null as string | null,
  checkedAt: null as string | null,
  error: null as string | null,
};
let nextPriceCheck = 0;

const table = (): OpenAITable => openaiPriceState.table ?? BUILT_IN;
/** Longest matching model-ID prefix wins (gpt-5.4-mini over gpt-5.4), so dated snapshots find their model. */
function lookup(rows: Record<string, Row> | undefined, model: string): Row | null {
  if (!rows) return null;
  const match = Object.keys(rows).filter((id) => model.startsWith(id)).sort((a, b) => b.length - a.length)[0];
  return match ? rows[match] : null;
}

/** Standard prices in the Claude table's order (input, short cache write, long cache write, cache read, output),
 * so the dashboard can split GPT cost by token type the same way. */
export function openaiPriceFor(model: string): number[] | null {
  const r = lookup(table().tiers.standard, model);
  if (!r || r[0] === null) return null;
  const input = r[0];
  return [input, r[3] ?? input, r[4] ?? r[3] ?? input, r[2] ?? input, r[1] ?? 0];
}

interface Details { cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number } }
interface RawUsage { service_tier?: string; input_tokens_details?: Details; prompt_tokens_details?: Details }

/** null when the model is not in the price table. Cache reads, 30-minute and 12-hour cache writes and long prompts
 * use their own prices; Flex, Fast and Ultrafast use their tier's table (Standard if the model isn't listed there).
 * Not modelled: data-residency uplifts and discounted background windows. */
export function estimateOpenAICost(u: Usage): number | null {
  if (!u.model) return null;
  const t = table();
  const raw = (u.raw ?? {}) as RawUsage;
  const tier = TIER_OF[raw.service_tier ?? ''] ?? 'standard';
  const row = lookup(t.tiers[tier], u.model) ?? lookup(t.tiers.standard, u.model);
  if (!row || row[0] === null) return null;
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  const p = prompt > t.longOver && row.length >= 10 && row[5] !== null ? row.slice(5) : row.slice(0, 5);
  const [input, output, cached, w30, w12] = p as [number, number | null, number | null, number | null, number | null];
  const writes = (raw.input_tokens_details ?? raw.prompt_tokens_details)?.cache_write_tokens_details;
  const write12h = writes?.ttl_12h_tokens ?? 0;
  const write30m = writes ? writes.ttl_30m_tokens ?? 0 : u.cache_creation_input_tokens;
  // Models without a listed write price charge cache writes as ordinary input.
  const cost = (u.input_tokens * input + u.cache_read_input_tokens * (cached ?? input) + write30m * (w30 ?? input)
    + write12h * (w12 ?? w30 ?? input) + u.output_tokens * (output ?? 0)) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

const money = (cell: string | undefined): number | null => {
  const m = /\$\s*([\d.]+)/.exec(cell ?? '');
  return m ? Number(m[1]) : null;
};
const cellsOf = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());

/** Reads the markdown tables in one section ("| Model | Input | Output | Cached input |", or the short/long-context
 * form with 30m and 12h write columns) into price rows. */
function parseSection(text: string, into: Record<string, Row>): void {
  let columns: string[] | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) { columns = null; continue; }
    const cells = cellsOf(line);
    if (cells[0] === 'Model') { columns = cells.map((c) => c.toLowerCase()); continue; }
    if (!columns || /^-+$/.test(cells[0])) continue;
    const col = (...names: string[]) => money(cells[columns!.findIndex((c) => names.includes(c))]);
    const id = cells[0].replace(/\([^)]*\)/g, '').trim();
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) continue;
    const short = [col('input', 'short context input'), col('output', 'short context output'),
      col('cached input', 'short context cached input'), col('30m write', 'short context 30m write'),
      col('12h write', 'short context 12h write')];
    const long = [col('long context input'), col('long context output'), col('long context cached input'),
      col('long context 30m write'), col('long context 12h write')];
    if (short[0] === null) continue;
    into[id] = long[0] === null ? short : [...short, ...long];
  }
}

/** Reads the text-token tables of OpenAI's pricing page (Standard, Flex, Fast, Ultrafast) and the embedding prices. */
export function parseOpenAIPricing(markdown: string): OpenAITable | null {
  const tiers: Record<string, Record<string, Row>> = {};
  for (const [tier, headings] of Object.entries(SECTIONS)) {
    for (const heading of headings) {
      const start = markdown.indexOf(`### ${heading}\n`);
      if (start < 0) continue;
      const end = markdown.indexOf('\n### ', start + 4);
      parseSection(markdown.slice(start, end > 0 ? end : undefined), tiers[tier] ??= {});
    }
  }
  if (!tiers.standard) return null;
  // Embeddings sit in a grouped table: "| Embedding | text-embedding-3-small | $0.02 | - | ... |".
  for (const line of markdown.split('\n')) {
    const cells = line.startsWith('| Embedding |') ? cellsOf(line) : null;
    const price = cells ? money(cells[2]) : null;
    if (cells && price !== null && /^[a-z0-9][a-z0-9.-]*$/.test(cells[1])) tiers.standard[cells[1]] = [price, null, null, null, null];
  }
  const over = /Long context:\s*>\s*([\d,]+)K input tokens/i.exec(markdown);
  return { longOver: over ? Number(over[1].replace(/,/g, '')) * 1000 : 272_000, tiers };
}

/** Sanity checks before a parsed table replaces the one in use. */
export function plausibleOpenAI(t: OpenAITable | null): t is OpenAITable {
  const standard = t?.tiers.standard;
  if (!t || !standard || Object.keys(standard).length < 10 || !Object.keys(standard).some((id) => id.startsWith('gpt-'))) return false;
  if (!(t.longOver >= 32_000 && t.longOver <= 10_000_000)) return false;
  for (const rows of Object.values(t.tiers)) {
    for (const row of Object.values(rows)) {
      for (let i = 0; i < row.length; i += 5) {
        const [input, output, cached, w30] = row.slice(i, i + 5);
        if (input === null) continue;
        if (!(input > 0 && input < 1000) || (output !== null && !(output >= input && output < 2000))
          || (cached !== null && cached > input) || (w30 !== null && w30 < input)) return false;
      }
    }
  }
  return true;
}

/** Keeps this instance's OpenAI price table current, like maybeUpdatePrices does for Claude. Only runs when an
 * OpenAI key is configured. */
export async function maybeUpdateOpenAIPrices(env: Env, now: number): Promise<void> {
  const db = env.USAGE_DB;
  if (!db || !env.OPENAI_API_KEY?.trim() || now < nextPriceCheck) return;
  nextPriceCheck = now + PRICE_RELOAD_MS;
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE name = 'openai_prices'`).first<{ value: string }>();
    if (row) Object.assign(openaiPriceState, JSON.parse(row.value));
    if (openaiPriceState.checkedAt && now - Date.parse(openaiPriceState.checkedAt) < PRICE_FETCH_MS) return;
    let status = 0;
    let parsed: OpenAITable | null = null;
    try {
      const r = await fetch(OPENAI_PRICING_URL, { headers: { accept: 'text/markdown' } });
      status = r.status;
      parsed = r.ok ? parseOpenAIPricing(await r.text()) : null;
    } catch {
      // status stays 0
    }
    const checkedAt = new Date(now).toISOString();
    if (plausibleOpenAI(parsed)) {
      Object.assign(openaiPriceState, { table: parsed, fetchedAt: checkedAt, checkedAt, error: null });
    } else {
      Object.assign(openaiPriceState, { checkedAt, error: status === 200 ? 'the price table on the page looked different than expected' : `the pricing page could not be loaded (${status || 'network error'})` });
    }
    await db.prepare(`INSERT INTO settings (name, value, updated_at) VALUES ('openai_prices', ?1, ?2)
        ON CONFLICT (name) DO UPDATE SET value = ?1, updated_at = ?2`)
      .bind(JSON.stringify(openaiPriceState), checkedAt).run();
  } catch {
    // Best effort: the current table stays in use.
  }
}
