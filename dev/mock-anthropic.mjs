// Fake Anthropic API (and ntfy) for developing the gateway locally without real keys or credit.
// Start it with `npm run mock`, point the gateway at it with UPSTREAM_ORIGIN=http://127.0.0.1:8798 in .dev.vars
// (see .dev.vars.example), then run `npm run dev`.
//
// Behaviour by x-api-key:
//   sk-good-*         200; streaming when the request asks for it; Start-tier rate-limit headers
//   sk-good-costok    like sk-good-*, and the cost report accepts it ($12.35)
//   sk-broke          400 "credit balance is too low" while state.broke is true
//   sk-revoked        401 authentication_error
// Controls:
//   POST /__toggle {"broke":false,"overloaded":true,"extraModel":true}   change behaviour (sk-good-* answer 529 when overloaded)
//   GET  /__hits     requests received since the last call (key, path, max_tokens)
//   POST /__ntfy     where the gateway sends phone notifications (NTFY_SERVER=http://127.0.0.1:8798/__ntfy)
//   GET  /__ntfy     notifications received since the last call
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8798);
const state = { broke: true, overloaded: false, extraModel: false };
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

  const key = req.headers['x-api-key'] ?? '';
  let request = {};
  try { request = JSON.parse(body); } catch {}
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
