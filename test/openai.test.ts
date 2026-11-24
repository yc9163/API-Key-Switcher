// Offline tests for the GPT side: usage from OpenAI responses and streams, the request tweak that makes streamed
// Chat Completions report usage, OpenAI's pricing page and cost, and how OpenAI errors are classified.
// Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateOpenAICost, openaiPriceFor, openaiPriceState, parseOpenAIPricing, plausibleOpenAI } from '../src/openai-pricing.ts';
import { classify, errorDetails } from '../src/shared.ts';
import { openaiSse, openaiUsageFromJson, SseUsageScanner, withStreamUsage, type Usage } from '../src/usage.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

const RESPONSES_USAGE = { input_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000,
  cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } }, output_tokens: 800,
  output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 12800 };

function scan(text: string, chunkSize = 1000): Usage {
  const s = new SseUsageScanner('fallback-model', openaiSse);
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) s.push(bytes.slice(i, i + chunkSize));
  return s.finish();
}

test('Responses usage: cached reads and both cache-write lifetimes are split out of the input', () => {
  const u = openaiUsageFromJson(JSON.stringify({ model: 'gpt-6.1-sol-2026-09-30', service_tier: 'default', usage: RESPONSES_USAGE }), null);
  assert.equal(u.model, 'gpt-6.1-sol-2026-09-30');
  assert.deepEqual([u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens], [1000, 4000, 7000, 800]);
  assert.equal(u.raw?.service_tier, 'default');
});

test('Chat Completions and Embeddings usage', () => {
  const chat = openaiUsageFromJson(JSON.stringify({ model: 'gpt-5.4-mini', usage: { prompt_tokens: 1200, completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 200 } } }), null);
  assert.deepEqual([chat.input_tokens, chat.cache_read_input_tokens, chat.output_tokens], [1000, 200, 300]);
  const emb = openaiUsageFromJson(JSON.stringify({ model: 'text-embedding-3-small', usage: { prompt_tokens: 7, total_tokens: 7 } }), null);
  assert.deepEqual([emb.input_tokens, emb.output_tokens], [7, 0]);
  assert.equal(openaiUsageFromJson('not json', 'gpt-x').model, 'gpt-x');
});

test('streamed Chat Completions: usage from the final chunk; model and tier from the stream', () => {
  const chunk = (extra: object) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-6-luna', service_tier: 'flex', ...extra })}\n\n`;
  let text = '';
  for (let i = 0; i < 400; i++) text += chunk({ choices: [{ index: 0, delta: { content: `word "usage":{"x":1} ${i} ` } }], usage: null });
  text += chunk({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 0 } } });
  text += 'data: [DONE]\n\n';
  const u = scan(text);
  assert.equal(u.model, 'gpt-6-luna');
  assert.equal(u.raw?.service_tier, 'flex');
  assert.deepEqual([u.input_tokens, u.output_tokens], [50, 400]);
});

test('streamed Responses: usage at the end of a response.completed line longer than the kept tail', () => {
  const reply = 'All work and no play. '.repeat(2000); // ~44 KB, repeated in response.completed
  const response = (status: string, usage: unknown) => ({ id: 'resp_1', object: 'response', status, model: 'gpt-6.1-sol-2026-09-30',
    output: status === 'completed' ? [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] : [],
    service_tier: 'default', usage, metadata: {} });
  const send = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let text = send('response.created', { response: response('in_progress', null) });
  for (let i = 0; i < 40; i++) text += send('response.output_text.delta', { delta: reply.slice(i * 1100, (i + 1) * 1100) });
  text += send('response.completed', { response: response('completed', RESPONSES_USAGE) });
  for (const size of [1, 997, 65536]) {
    const u = scan(text, size);
    assert.equal(u.model, 'gpt-6.1-sol-2026-09-30', `chunk ${size}`);
    assert.deepEqual([u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens], [1000, 4000, 7000, 800], `chunk ${size}`);
  }
});

test('withStreamUsage asks streamed Chat Completions for usage, and leaves everything else alone', () => {
  const add = (body: object) => JSON.parse(dec.decode(withStreamUsage(enc.encode(JSON.stringify(body)).buffer as ArrayBuffer)));
  assert.deepEqual(add({ model: 'm', stream: true, messages: [] }).stream_options, { include_usage: true });
  assert.deepEqual(add({ model: 'm', stream: true, stream_options: { include_usage: false } }).stream_options, { include_usage: false });
  assert.equal(add({ model: 'm', stream: false }).stream_options, undefined);
  // The words inside message text are escaped JSON, so they don't count.
  assert.equal(add({ model: 'm', messages: [{ role: 'user', content: '"stream": true' }] }).stream_options, undefined);
});

// A cut-down copy of the pricing page's markdown, in its real layout.
const PAGE = `# Pricing

### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-astra | $8.00 | $40.00 | $0.40 | $10.00 | $20.00 | $16.00 | $60.00 | $0.80 | $20.00 | $40.00 |
| gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 | $0.20 | $0.75 | $0.02 | $0.25 | $0.50 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |
| gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |
| gpt-5.4-nano | $0.20 | $1.25 | $0.02 |
| gpt-5 | $1.25 | $10.00 | $0.125 |
| gpt-5-mini | $0.25 | $2.00 | $0.025 |
| gpt-4.1 | $2.00 | $8.00 | $0.50 |
| o3 | $2.00 | $8.00 | $0.50 |

### Batch pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5 | $0.625 | $5.00 | $0.0625 |

### Flex pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.1-sol | $1.00 | $5.00 | $0.05 |

### Fast pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.1-sol | $4.00 | $20.00 | $0.20 |

Short context: ≤272K input tokens. Long context: >272K input tokens.

### Grouped Pricing Table data

| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| Embedding | text-embedding-3-small | $0.02 | - | - | - | - |
`;

test('parses the pricing page: tiers, long-context rows, missing prices and embeddings', () => {
  const t = parseOpenAIPricing(PAGE);
  assert.ok(t && plausibleOpenAI(t));
  assert.equal(t.longOver, 272_000);
  assert.deepEqual(t.tiers.standard['gpt-6.1-sol'], [2, 10, 0.1, 2.5, 5, 4, 15, 0.2, 5, 10]);
  assert.deepEqual(t.tiers.standard['gpt-5.5'], [5, 30, 0.5, null, null, 10, 45, 1, null, null]);
  assert.deepEqual(t.tiers.standard['gpt-5.4-mini'], [0.75, 4.5, 0.075, null, null]);
  assert.deepEqual(t.tiers.standard['text-embedding-3-small'], [0.02, null, null, null, null]);
  assert.deepEqual(t.tiers.flex['gpt-6.1-sol'], [1, 5, 0.05, null, null]);
  assert.equal(t.tiers.batch, undefined); // the gateway has no batch endpoint
  assert.equal(plausibleOpenAI(parseOpenAIPricing('# Pricing\n\nnothing here')), false);
  // An implausible number (cached dearer than input) rejects the whole table.
  assert.equal(plausibleOpenAI(parseOpenAIPricing(PAGE.replace('| gpt-5 | $1.25 | $10.00 | $0.125 |', '| gpt-5 | $1.25 | $10.00 | $9.00 |'))), false);
});

const usage = (model: string, input: number, read: number, write30: number, write12: number, output: number, tier = 'default'): Usage => ({
  model, input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write30 + write12, output_tokens: output,
  raw: { service_tier: tier, input_tokens_details: { cached_tokens: read, cache_write_tokens: write30 + write12,
    cache_write_tokens_details: { ttl_30m_tokens: write30, ttl_12h_tokens: write12 } } },
});

test('cost: cache reads, 30-minute and 12-hour writes, long prompts and processing tiers', () => {
  openaiPriceState.table = parseOpenAIPricing(PAGE);
  try {
    // The pricing guide's own example at gpt-6.1-sol prices: 1,000 input, 4,000 cached, 3,000 + 4,000 written, 800 out.
    assert.equal(estimateOpenAICost(usage('gpt-6.1-sol-2026-09-30', 1000, 4000, 3000, 4000, 800)),
      (1000 * 2 + 4000 * 0.1 + 3000 * 2.5 + 4000 * 5 + 800 * 10) / 1e6);
    // Over 272K prompt tokens: long-context prices.
    assert.equal(estimateOpenAICost(usage('gpt-6.1-sol', 300_000, 0, 0, 0, 1000)), (300_000 * 4 + 1000 * 15) / 1e6);
    // Flex and Fast use their tables; "priority" is Fast mode's old name; a tier without the model falls back to Standard.
    assert.equal(estimateOpenAICost(usage('gpt-6.1-sol', 1000, 0, 0, 0, 1000, 'flex')), (1000 * 1 + 1000 * 5) / 1e6);
    assert.equal(estimateOpenAICost(usage('gpt-6.1-sol', 1000, 0, 0, 0, 1000, 'priority')), (1000 * 4 + 1000 * 20) / 1e6);
    assert.equal(estimateOpenAICost(usage('gpt-5-mini', 1000, 0, 0, 0, 1000, 'flex')), (1000 * 0.25 + 1000 * 2) / 1e6);
    // No listed cached price (pro models): cached input costs full price. No write price: writes cost input price.
    assert.equal(estimateOpenAICost(usage('gpt-5.5-pro', 0, 1000, 0, 0, 0)), (1000 * 30) / 1e6);
    assert.equal(estimateOpenAICost(usage('gpt-5', 0, 0, 1000, 0, 0)), (1000 * 1.25) / 1e6);
    // Longest prefix: gpt-5-mini, not gpt-5. Unknown models aren't priced.
    assert.equal(estimateOpenAICost(usage('gpt-5-mini-2026-01-01', 1_000_000, 0, 0, 0, 0)), 0.25);
    assert.equal(estimateOpenAICost(usage('davinci-002', 1000, 0, 0, 0, 0)), null);
    assert.deepEqual(openaiPriceFor('gpt-6.1-sol'), [2, 2.5, 5, 0.1, 10]); // in the Claude table's column order
  } finally {
    openaiPriceState.table = null;
  }
  // The built-in table (used until the page is read) prices the same model the same way.
  assert.equal(estimateOpenAICost(usage('gpt-6.1-sol', 100_000, 0, 0, 0, 0)), 0.2);
});

test('OpenAI errors: no credit, spend limits, rate limits and bad keys', () => {
  const body = (type: string, code: string) => JSON.stringify({ error: { message: 'm', type, param: null, code } });
  assert.equal(classify(429, body('insufficient_quota', 'credit_balance_exhausted')), 'out_of_credit');
  assert.equal(classify(429, body('insufficient_quota', 'insufficient_quota')), 'out_of_credit');
  assert.equal(classify(429, body('insufficient_quota', 'project_spend_limit_exceeded')), 'billing');
  assert.equal(classify(429, body('rate_limit_error', 'rate_limit_exceeded')), 'rate_limited');
  assert.equal(classify(401, body('invalid_request_error', 'invalid_api_key')), 'invalid_key');
  assert.equal(errorDetails(body('insufficient_quota', 'credit_balance_exhausted')).type, 'credit_balance_exhausted');
  // Anthropic errors (no code) keep their type.
  assert.equal(errorDetails(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } })).type, 'overloaded_error');
});
