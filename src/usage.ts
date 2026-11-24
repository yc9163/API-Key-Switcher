/** Reads token usage from Anthropic Messages responses (and, with another parser, OpenAI's) without keeping
 * prompt or reply text. */
export interface Usage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  raw: Record<string, unknown> | null; // Latest usage object as Anthropic returned it.
}

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
// message_start comes first in a stream and the final message_delta just before message_stop,
// so only the head and tail of the stream are kept; everything between is passed through unread.
const EDGE_BYTES = 16_384;

export const emptyUsage = (model: string | null = null): Usage => ({
  model, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, raw: null,
});

/** Applies an API usage object; later values (message_delta's cumulative totals) replace earlier ones. */
function merge(target: Usage, usage: unknown, model?: unknown): void {
  if (typeof model === 'string') target.model = model;
  if (!usage || typeof usage !== 'object') return;
  const fields = usage as Record<string, unknown>;
  for (const name of TOKEN_FIELDS) {
    if (typeof fields[name] === 'number') target[name] = fields[name] as number;
  }
  target.raw = { ...(target.raw ?? {}), ...fields };
}

/** Usage from a non-streaming Messages response body. */
export function usageFromJson(text: string, fallbackModel: string | null): Usage {
  const result = emptyUsage(fallbackModel);
  try {
    const message = JSON.parse(text) as { model?: unknown; usage?: unknown };
    merge(result, message.usage, message.model);
  } catch {
    // Not JSON: leave counts at zero.
  }
  return result;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

/** Reads usage from the kept head and tail of a stream: one string when nothing between them was dropped,
 * otherwise the two separately (a line cut at either edge simply fails to parse). */
export type SseParser = (parts: string[], fallbackModel: string | null) => Usage;

/** Anthropic streams: usage from message_start and the final message_delta. */
export function anthropicSse(parts: string[], fallbackModel: string | null): Usage {
  const result = emptyUsage(fallbackModel);
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data: ') || !line.slice(0, 48).includes('"type":"message_')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type?: string; message?: { model?: unknown; usage?: unknown }; usage?: unknown };
        if (event.type === 'message_start') merge(result, event.message?.usage, event.message?.model);
        else if (event.type === 'message_delta') merge(result, event.usage);
      } catch {
        // Truncated line at a head/tail edge.
      }
    }
  }
  return result;
}

/** Collects the head and tail of an SSE stream, then extracts usage from them (Anthropic's format by default). */
export class SseUsageScanner {
  private head: Uint8Array[] = [];
  private headBytes = 0;
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private overlapped = true; // false once bytes between head and tail were dropped
  private readonly fallbackModel: string | null;
  private readonly parse: SseParser;

  constructor(fallbackModel: string | null, parse: SseParser = anthropicSse) {
    this.fallbackModel = fallbackModel;
    this.parse = parse;
  }

  push(chunk: Uint8Array): void {
    if (this.headBytes < EDGE_BYTES) {
      this.head.push(chunk);
      this.headBytes += chunk.byteLength;
      return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.byteLength;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].byteLength >= EDGE_BYTES) {
      this.tailBytes -= this.tail.shift()!.byteLength;
      this.overlapped = false;
    }
  }

  finish(): Usage {
    const decoder = new TextDecoder();
    const headText = decoder.decode(concat(this.head));
    const tailText = decoder.decode(concat(this.tail));
    // When nothing was dropped, head + tail is the whole stream; otherwise read them separately.
    return this.parse(this.overlapped ? [headText + tailText] : [headText, tailText], this.fallbackModel);
  }
}

/** Passes a response stream through unchanged, reporting usage once it ends or the client disconnects. */
export function meteredStream(body: ReadableStream<Uint8Array>, fallbackModel: string | null,
  onDone: (usage: Usage, completed: boolean) => void, parse: SseParser = anthropicSse): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = new SseUsageScanner(fallbackModel, parse);
  let finished = false;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    onDone(scanner.finish(), completed);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(true);
          controller.close();
          return;
        }
        scanner.push(value);
        controller.enqueue(value);
      } catch (err) {
        finish(false);
        controller.error(err);
      }
    },
    cancel(reason) {
      // Client went away: cancelling upstream stops Anthropic generating (and billing) the rest.
      finish(false);
      return reader.cancel(reason);
    },
  });
}

// ---------- OpenAI responses (src/openai.ts) ----------

interface OpenAIUsage {
  input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

/** Maps an OpenAI usage object (Responses, Chat Completions or Embeddings) onto the gateway's columns: input
 * is the uncached part, cache writes and reads are counted separately, output includes reasoning tokens. */
export function openaiUsage(usage: unknown, model: string | null, serviceTier: string | null): Usage {
  const result = emptyUsage(model);
  if (!usage || typeof usage !== 'object') return result;
  const u = usage as OpenAIUsage;
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  const details = u.input_tokens_details ?? u.prompt_tokens_details;
  const total = n(u.input_tokens ?? u.prompt_tokens);
  result.cache_read_input_tokens = n(details?.cached_tokens);
  result.cache_creation_input_tokens = n(details?.cache_write_tokens);
  result.input_tokens = Math.max(0, total - result.cache_read_input_tokens - result.cache_creation_input_tokens);
  result.output_tokens = n(u.output_tokens ?? u.completion_tokens);
  result.raw = serviceTier ? { ...(usage as Record<string, unknown>), service_tier: serviceTier } : { ...(usage as Record<string, unknown>) };
  return result;
}

/** Usage from a non-streaming OpenAI response body. */
export function openaiUsageFromJson(text: string, fallbackModel: string | null): Usage {
  try {
    const body = JSON.parse(text) as { model?: unknown; usage?: unknown; service_tier?: unknown };
    return openaiUsage(body.usage, typeof body.model === 'string' ? body.model : fallbackModel,
      typeof body.service_tier === 'string' ? body.service_tier : null);
  } catch {
    return emptyUsage(fallbackModel);
  }
}

/** The JSON object that starts at text[start] ('{'), or null if it is cut off. */
function objectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** OpenAI streams. Chat Completions sends usage in a last small chunk (with stream_options.include_usage); the
 * Responses API puts it at the end of response.completed, whose data line repeats the whole reply and can be longer
 * than the tail the gateway keeps. So instead of parsing whole lines, this finds the last "usage" object in the text
 * (quotes inside reply text are escaped, so only real keys match), the model near the start and the service tier. */
export function openaiSse(parts: string[], fallbackModel: string | null): Usage {
  const model = /"model"\s*:\s*"([^"]{1,100})"/.exec(parts[0])?.[1] ?? fallbackModel;
  let usage: unknown = null;
  let tier: string | null = null;
  for (const part of parts) {
    for (const m of part.matchAll(/"service_tier"\s*:\s*"([a-z_]{1,20})"/g)) tier = m[1];
    const re = /"usage"\s*:\s*\{/g;
    let last = -1;
    for (let m = re.exec(part); m; m = re.exec(part)) last = m.index + m[0].length - 1;
    const found = last >= 0 ? objectAt(part, last) : null;
    if (found) {
      try { usage = JSON.parse(found); } catch { /* cut off: keep any earlier one */ }
    }
  }
  return openaiUsage(usage, model, tier);
}

/** Streaming Chat Completions report usage only when asked: add stream_options.include_usage if the caller didn't
 * set stream_options. (Quotes inside message text are escaped in JSON, so they can't match these patterns.) */
export function withStreamUsage(body: ArrayBuffer): ArrayBuffer {
  const text = new TextDecoder().decode(body);
  if (!/"stream"\s*:\s*true/.test(text) || /"stream_options"\s*:/.test(text)) return body;
  const open = text.indexOf('{');
  if (open < 0) return body;
  return new TextEncoder().encode(`${text.slice(0, open + 1)}"stream_options":{"include_usage":true},${text.slice(open + 1)}`).buffer as ArrayBuffer;
}

/** Model named in the request, read from the start of the body only (cheap even for 32 MB bodies). */
export function requestModel(body: ArrayBuffer | null): string | null {
  if (!body) return null;
  const start = new TextDecoder().decode(body.slice(0, 4096));
  return start.match(/"model"\s*:\s*"([^"]{1,100})"/)?.[1] ?? null;
}
