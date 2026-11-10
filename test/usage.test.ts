// Offline tests for src/usage.ts (reading token usage from responses). Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meteredStream, requestModel, SseUsageScanner, usageFromJson, type Usage } from '../src/usage.ts';

const enc = new TextEncoder();

/** An Anthropic SSE stream with `textDeltas` content events between message_start and message_delta. */
function sse(textDeltas: number, deltaText = 'hello world '): string {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":500,"output_tokens":1}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  ];
  for (let i = 0; i < textDeltas; i++) {
    // Reply text that mentions "message_delta" must not confuse the scanner.
    events.push(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${deltaText} \\"type\\":\\"message_delta\\" ${i}"}}\n\n`);
  }
  events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
  events.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":500,"output_tokens":987,"server_tool_use":{"web_search_requests":2}}}\n\n`);
  events.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  return events.join('');
}

function scan(text: string, chunkSize: number): Usage {
  const s = new SseUsageScanner('fallback-model');
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) s.push(bytes.slice(i, i + chunkSize));
  return s.finish();
}

function assertFullUsage(u: Usage, label: string): void {
  assert.equal(u.model, 'claude-opus-5-5', label);
  assert.equal(u.input_tokens, 120, label);
  assert.equal(u.output_tokens, 987, label);
  assert.equal(u.cache_creation_input_tokens, 30, label);
  assert.equal(u.cache_read_input_tokens, 500, label);
  assert.equal((u.raw?.server_tool_use as { web_search_requests: number }).web_search_requests, 2, label);
}

test('reads usage from streams of any size and chunking', () => {
  assertFullUsage(scan(sse(3), 7), 'short stream, tiny chunks');
  assertFullUsage(scan(sse(3), 100_000), 'short stream, one chunk');
  assertFullUsage(scan(sse(5000), 64), 'long stream (middle dropped), small chunks');
  assertFullUsage(scan(sse(5000), 4093), 'long stream, odd chunks');
  assertFullUsage(scan(sse(5000, 'é漢字🙂'), 333), 'long stream, multibyte text');
  assertFullUsage(scan(sse(5000).replaceAll('\n', '\r\n'), 1000), 'CRLF line endings');
});

test('a stream cut off before message_delta keeps what message_start reported', () => {
  const partial = scan(sse(10).split('event: content_block_stop')[0], 50);
  assert.equal(partial.input_tokens, 120);
  assert.equal(partial.output_tokens, 1);
});

test('reads usage from non-streaming JSON', () => {
  const msg = JSON.stringify({ id: 'msg', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3 } });
  const u = usageFromJson(msg, 'x');
  assert.deepEqual([u.model, u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens],
    ['claude-sonnet-5-5', 11, 22, 3, 0]);
  assert.equal(usageFromJson('not json', 'm').model, 'm');
});

test('requestModel reads the model from the start of the body only', () => {
  assert.equal(requestModel(enc.encode('{"model": "claude-opus-5-5","max_tokens":5}').buffer as ArrayBuffer), 'claude-opus-5-5');
  assert.equal(requestModel(null), null);
});

test('meteredStream passes bytes through unchanged and reports once at the end', async () => {
  const original = sse(2000);
  const reported: Array<[Usage, boolean]> = [];
  const src = new ReadableStream<Uint8Array>({
    start(c) { const b = enc.encode(original); for (let i = 0; i < b.length; i += 777) c.enqueue(b.slice(i, i + 777)); c.close(); },
  });
  const out = await new Response(meteredStream(src, null, (u, completed) => reported.push([u, completed]))).text();
  assert.equal(out, original);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][1], true);
  assertFullUsage(reported[0][0], 'metered stream');
});

test('a client disconnect cancels the upstream and reports once as incomplete', async () => {
  let upstreamCancelled = false;
  const reported: Array<[Usage, boolean]> = [];
  const slow = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(enc.encode(sse(1).slice(0, 400))); },
    cancel() { upstreamCancelled = true; },
  });
  const reader = meteredStream(slow, 'req-model', (u, completed) => reported.push([u, completed])).getReader();
  await reader.read();
  await reader.cancel('client gone');
  assert.equal(upstreamCancelled, true);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][1], false);
  assert.equal(reported[0][0].input_tokens, 120);
});
