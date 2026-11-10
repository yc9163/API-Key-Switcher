// Offline tests for src/pricing.ts (reading Anthropic's pricing page and estimating cost). Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCost, parsePricing, plausible, priceFor, priceState } from '../src/pricing.ts';
import type { Usage } from '../src/usage.ts';

// The shape of the "Model pricing" table on https://platform.claude.com/docs/en/about-claude/pricing.md
// (links, footnotes and a tiered row included, as on the real page).
const PAGE = `# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 3.5 ([retired, except on Claude Models on Google Cloud (Google managed)](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

## Batch processing

| Model | Batch input | Batch output |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

const usage = (model: string, input: number, output: number, extra: Partial<Usage> = {}): Usage => ({
  model, input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, raw: null, ...extra,
});

test('parses the model price table, including linked names, footnotes and prompt-length tiers', () => {
  const t = parsePricing(PAGE)!;
  assert.deepEqual(Object.keys(t), ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5',
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-3-5']);
  assert.deepEqual(t['claude-opus-5-5'], [{ over: 0, p: [4, 5, 8, 0.2, 20] }]);
  assert.deepEqual(t['claude-haiku-5-5'], [{ over: 0, p: [0.1, 0.125, 0.2, 0.01, 0.5] }, { over: 100_000, p: [0.5, 0.625, 1, 0.05, 2.5] }]);
  assert.ok(plausible(t));
  assert.equal(t['claude-opus-5-5'].length, 1, 'rows from later sections (batch prices) are ignored');
});

test('rejects pages that do not look like the price table', () => {
  assert.equal(plausible(parsePricing('no table here')), false);
  assert.equal(plausible(parsePricing('## Model pricing\n| Claude X 1 | n/a |')), false);
  const swapped = PAGE.replace('| $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |', '| $20 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $4 / MTok |');
  assert.equal(plausible(parsePricing(swapped)), false, 'output cheaper than input is implausible');
});

test('estimates cost with the longest matching model ID and the right tier', () => {
  priceState.table = parsePricing(PAGE);
  try {
    assert.equal(estimateCost(usage('claude-opus-5-5', 1000, 500)), 0.014);
    assert.equal(estimateCost(usage('claude-opus-5', 1000, 500)), 0.0175, 'claude-opus-5 is not claude-opus-5-5');
    assert.equal(estimateCost(usage('claude-haiku-5-5', 50_000, 1000)), 0.0055, 'base tier');
    assert.equal(estimateCost(usage('claude-haiku-5-5', 150_000, 1000)), 0.0775, 'over 100,000 prompt tokens');
    assert.equal(estimateCost(usage('claude-unknown-9', 1000, 500)), null);
    assert.deepEqual(priceFor('claude-sonnet-5-5'), [2, 2.5, 4, 0.1, 10]);
    // Cache split, fast mode (2x) and web searches ($0.01 each).
    const cached = usage('claude-opus-5-5', 100, 0, { cache_creation_input_tokens: 1000, cache_read_input_tokens: 10_000,
      raw: { cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } } });
    assert.equal(estimateCost(cached), (100 * 4 + 600 * 5 + 400 * 8 + 10_000 * 0.2) / 1e6);
    assert.equal(estimateCost(usage('claude-opus-5-5', 1000, 500, { raw: { speed: 'fast' } })), 0.028);
    assert.equal(estimateCost(usage('claude-opus-5-5', 0, 0, { raw: { server_tool_use: { web_search_requests: 3 } } })), 0.03);
  } finally {
    priceState.table = null;
  }
});

test('falls back to the built-in prices when no table has been read', () => {
  assert.equal(priceState.table, null);
  assert.equal(estimateCost(usage('claude-opus-5-5', 1000, 500)), 0.014);
});
