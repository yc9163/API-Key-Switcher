// Fake Anthropic API (and ntfy) for developing the gateway locally without real keys or credit.
// Start it with `npm run mock`, point the gateway at it with UPSTREAM_ORIGIN=http://127.0.0.1:8798 in .dev.vars
// (see .dev.vars.example), then run `npm run dev`.
//
// Behaviour by x-api-key:
//   sk-good-*         200; streaming when the request asks for it; Start-tier rate-limit headers
//   sk-good-costok    like sk-good-*, and the cost report accepts it ($12.35)
//   sk-broke          400 "credit balance is too low" while state.broke is true
//   sk-revoked        401 authentication_error
// OpenAI side, under /openai (OPENAI_UPSTREAM_ORIGIN=http://127.0.0.1:8798/openai), by Authorization: Bearer:
//   sk-openai-good    chat completions, responses (streaming too) and embeddings; 429 credit_balance_exhausted
//                     while state.gptBroke is true
// Controls:
//   POST /__toggle {"broke":false,"overloaded":true,"extraModel":true,"gptBroke":true}   change behaviour
//                    (sk-good-* answer 529 when overloaded)
//   GET  /__hits     requests received since the last call (key, path, max_tokens)
//   POST /__ntfy     where the gateway sends phone notifications (NTFY_SERVER=http://127.0.0.1:8798/__ntfy)
//   GET  /__ntfy     notifications received since the last call
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8798);
const state = { broke: true, overloaded: false, extraModel: false, gptBroke: false };

// OpenAI usage objects as the real API returns them: Responses (with 30-minute and 12-hour cache writes) and Chat.
const RESPONSES_USAGE = { input_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000,
  cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } }, output_tokens: 800,
  output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 12800 };
const CHAT_USAGE = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 0 } };

function openai(req, res, url, request, json) {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const path = url.pathname.slice('/openai'.length);
  hits.push({ key, path: `/openai${path}`, maxTokens: request.max_output_tokens ?? request.max_completion_tokens ?? null,
    streamOptions: request.stream_options ?? null });
  const headers = { 'openai-organization': 'user-mockorganization', 'x-request-id': `req_oa_${hits.length}`,
    'x-ratelimit-limit-requests': '5000', 'x-ratelimit-limit-tokens': '4000000' };
  const fail = (status, type, code, message) => json(status, { error: { message, type, param: null, code } }, headers);
  if (key !== 'sk-openai-good') return fail(401, 'invalid_request_error', 'invalid_api_key', 'Incorrect API key provided.');
  if (state.gptBroke && req.method === 'POST' && path !== '/v1/responses/input_tokens') {
    return fail(429, 'insufficient_quota', 'credit_balance_exhausted', 'Your organization has no prepaid credits remaining.');
  }
  const model = request.model || 'gpt-6.1-sol';
  const tier = request.service_tier === 'flex' ? 'flex' : 'default';
  if (path === '/v1/models') return json(200, { object: 'list', data: [{ id: 'gpt-6.1-sol', object: 'model', owned_by: 'openai' }] }, headers);
  if (path === '/v1/embeddings') {
    return json(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.01, -0.02] }], model,
      usage: { prompt_tokens: 1, total_tokens: 1 } }, headers);
  }
  if (path === '/v1/chat/completions') {
    if (!request.stream) {
      return json(200, { id: 'chatcmpl-mock', object: 'chat.completion', model: `${model}-2026-09-30`, service_tier: tier,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: CHAT_USAGE }, headers);
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    const chunk = (extra) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, service_tier: tier, ...extra })}\n\n`);
    const withUsage = request.stream_options?.include_usage === true;
    for (const word of ['Hello', ' from', ' GPT']) chunk({ choices: [{ index: 0, delta: { content: word } }], ...(withUsage ? { usage: null } : {}) });
    if (withUsage) chunk({ choices: [], usage: CHAT_USAGE });
    res.end('data: [DONE]\n\n');
    return;
  }
  if (path === '/v1/responses') {
    // A long reply: response.completed repeats it, so its line is longer than the tail the gateway keeps.
    const text = 'All work and no play. '.repeat(request.stream ? 1500 : 2);
    const response = (status, usage) => ({ id: 'resp_mock', object: 'response', status, model: `${model}-2026-09-30`,
      output: status === 'completed' ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : [],
      service_tier: tier, tools: [], usage, metadata: {} });
    if (!request.stream) return json(200, response('completed', RESPONSES_USAGE), headers);
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: response('in_progress', null) });
    for (let i = 0; i < 30; i++) send('response.output_text.delta', { delta: text.slice(i * 1100, (i + 1) * 1100) });
    send('response.completed', { response: response('completed', RESPONSES_USAGE) });
    res.end();
    return;
  }
  if (path === '/v1/responses/input_tokens') return json(200, { object: 'response.input_tokens', input_tokens: 12 }, headers);
  return fail(404, 'invalid_request_error', 'not_found', `mock: no route for ${req.method} ${url.pathname}`);
}
let hits = [];
let notes = [];

const RATE_LIMIT_HEADERS = {
  'anthropic-ratelimit-requests-limit': '4000',
  'anthropic-ratelimit-input-tokens-limit': '2000000',
  'anthropic-ratelimit-output-tokens-limit': '400000',
  'anthropic-workspace-id': 'wrkspc_mock',
};
const model = (id, name, created) => ({ type: 'model', id, display_name: name, created_at: created, max_input_tokens: 1000000, max_tokens: 128000 });

function streamReply(res, headers, modelId) {
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: modelId, content: [],
    usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const word of ['Hello', ' from', ' the', ' mock']) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } });
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (status, obj, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/__toggle') { Object.assign(state, JSON.parse(body || '{}')); return json(200, state); }
  if (url.pathname === '/__hits') { const out = hits; hits = []; return json(200, out); }
  if (url.pathname === '/__ntfy' && req.method === 'POST') { notes.push(JSON.parse(body || '{}')); return json(200, {}); }
  if (url.pathname === '/__ntfy') { const out = notes; notes = []; return json(200, out); }

  let request = {};
  try { request = JSON.parse(body); } catch {}
  if (url.pathname.startsWith('/openai/')) return openai(req, res, url, request, json);
  const key = req.headers['x-api-key'] ?? '';
  hits.push({ key, path: url.pathname, maxTokens: request.max_tokens ?? null });
  const headers = { 'anthropic-organization-id': `org-${key}`, 'request-id': `req_mock_${hits.length}`, ...RATE_LIMIT_HEADERS };
  const fail = (status, type, message) => json(status, { type: 'error', error: { type, message } }, headers);

  if (key === 'sk-revoked') return fail(401, 'authentication_error', 'invalid x-api-key');
  if (key === 'sk-broke' && state.broke) {
    return fail(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
  }
  if (key.startsWith('sk-good') && state.overloaded) return fail(529, 'overloaded_error', 'Overloaded');

  if (url.pathname.startsWith('/v1/models')) {
    const data = [model('claude-opus-5-5', 'Claude Opus 5.5', '2026-09-01T00:00:00Z'), model('claude-haiku-5-5', 'Claude Haiku 5.5', '2026-09-15T00:00:00Z')];
    if (state.extraModel) data.unshift(model('claude-mock-6', 'Claude Mock 6', '2026-11-04T00:00:00Z'));
    return json(200, { data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id }, headers);
  }
  if (url.pathname.startsWith('/v1/organizations/cost_report')) {
    if (key === 'sk-good-costok') return json(200, { data: [{ results: [{ amount: '1000.000000' }] }, { results: [{ amount: '235.000000' }] }], has_more: false }, headers);
    return fail(401, 'authentication_error', 'This endpoint requires an Admin API key.');
  }
  if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: 8 }, headers);
  if (url.pathname === '/v1/messages') {
    const modelId = request.model || 'claude-opus-5-5';
    if (request.stream) return streamReply(res, headers, modelId);
    const zero = request.max_tokens === 0; // the gateway's key check
    return json(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: modelId, content: zero ? [] : [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: zero ? 8 : 1000, output_tokens: zero ? 0 : 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, headers);
  }
  return fail(404, 'not_found_error', `mock: no route for ${req.method} ${url.pathname}`);
}).listen(PORT, '127.0.0.1', () => console.log(`Fake Anthropic API on http://127.0.0.1:${PORT}`));
