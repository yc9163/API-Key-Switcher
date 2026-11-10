/** Reads token usage from Anthropic Messages responses without keeping prompt or reply text. */
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

/** Collects the head and tail of an SSE stream, then extracts usage from message_start / message_delta. */
export class SseUsageScanner {
  private head: Uint8Array[] = [];
  private headBytes = 0;
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private overlapped = true; // false once bytes between head and tail were dropped
  private readonly fallbackModel: string | null;

  constructor(fallbackModel: string | null) {
    this.fallbackModel = fallbackModel;
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
    const result = emptyUsage(this.fallbackModel);
    const decoder = new TextDecoder();
    const headText = decoder.decode(concat(this.head));
    const tailText = decoder.decode(concat(this.tail));
    // When nothing was dropped, head + tail is the whole stream; otherwise read them separately
    // (a line cut at either edge simply fails to parse and is skipped).
    const parts = this.overlapped ? [headText + tailText] : [headText, tailText];
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
}

/** Passes a response stream through unchanged, reporting usage once it ends or the client disconnects. */
export function meteredStream(body: ReadableStream<Uint8Array>, fallbackModel: string | null,
  onDone: (usage: Usage, completed: boolean) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = new SseUsageScanner(fallbackModel);
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

/** Model named in the request, read from the start of the body only (cheap even for 32 MB bodies). */
export function requestModel(body: ArrayBuffer | null): string | null {
  if (!body) return null;
  const start = new TextDecoder().decode(body.slice(0, 4096));
  return start.match(/"model"\s*:\s*"([^"]{1,100})"/)?.[1] ?? null;
}
