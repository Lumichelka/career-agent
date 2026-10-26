import test from 'node:test';
import assert from 'node:assert/strict';
import {PRICE_VERSION, USD_CNY, PRICES, priceFor, estimateCost, formatCny, estimateCallCost} from '../src/model/prices.mjs';

test('价表：每条都带来源与访问日期，币种与单价可核对', () => {
  assert.ok(Array.isArray(PRICES) && PRICES.length >= 10);
  assert.equal(USD_CNY, 7.2, 'USD→CNY 固定 7.2');
  for (const entry of PRICES) {
    assert.equal(typeof entry.preset, 'string');
    assert.ok('model' in entry);
    assert.ok(['USD', 'CNY'].includes(entry.currency), entry.preset + ' 币种');
    assert.ok(Number.isFinite(entry.input) && entry.input >= 0, entry.preset + ' 输入价');
    assert.ok(Number.isFinite(entry.output) && entry.output >= 0, entry.preset + ' 输出价');
    assert.match(entry.sourceUrl, /^https?:\/\//, entry.preset + ' 来源');
    assert.match(entry.accessedAt, /^\d{4}-\d{2}-\d{2}$/, entry.preset + ' 访问日期');
  }
});

test('计价：美元按 7.2 折人民币并标记估算', () => {
  const cost = estimateCost({preset: 'deepseek', model: 'deepseek-flash', usage: {input: 1e6, output: 1e6}});
  assert.ok(cost);
  assert.equal(cost.estimated, true);
  assert.equal(cost.priceVersion, PRICE_VERSION);
  assert.equal(cost.cny, 5.4, '(0.15 + 0.6) USD × 7.2');
  assert.match(cost.sourceUrl, /deepseek/);
});

test('计价：免费型号是 0 元，但仍算有价', () => {
  const cost = estimateCost({preset: 'zhipu', model: 'glm-4.6v-flash', usage: {input: 123456, output: 7890}});
  assert.ok(cost);
  assert.equal(cost.cny, 0);
  assert.equal(cost.estimated, true);
  assert.equal(formatCny(cost.cny), '≈¥0');
});

test('计价：价表没有的型号返回 null（只显示 tokens）', () => {
  assert.equal(estimateCost({preset: 'moonshot', model: 'kimi-k3.1-pro', usage: {input: 100, output: 20}}), null);
  assert.equal(estimateCost({preset: 'openai', model: 'gpt-4o', usage: {input: 100, output: 20}}), null);
  assert.equal(priceFor({preset: 'moonshot', model: 'kimi-k3.1-pro'}), null);
  assert.equal(estimateCost({preset: 'deepseek', model: 'deepseek-flash', usage: null}), null);
});

test('计价：本机模型按 0 元计，模型名不固定', () => {
  const cost = estimateCost({preset: 'ollama', model: 'qwen3-vl:8b', usage: {input: 9000, output: 1200}});
  assert.equal(cost.cny, 0);
  assert.match(cost.sourceUrl, /ollama/);
  assert.ok(estimateCost({preset: 'lmstudio', model: 'whatever', usage: {input: 1, output: 1}}));
});

test('金额一律带「≈¥」前缀，未知或缺失返回空串', () => {
  assert.equal(formatCny(0), '≈¥0');
  assert.ok(formatCny(0.0022).startsWith('≈¥'));
  assert.ok(formatCny(0.0022).includes('0.0022'));
  assert.ok(formatCny(5.4).startsWith('≈¥'));
  assert.equal(formatCny(null), '');
  assert.equal(formatCny(Number.NaN), '');
});

test('候选卡的约每次费用：有价给数字，无价给 null，视觉假设比文本高', () => {
  const text = estimateCallCost({preset: 'deepseek', model: 'deepseek-flash', capabilities: ['text', 'tools']});
  const vision = estimateCallCost({preset: 'deepseek', model: 'deepseek-flash', capabilities: ['text', 'tools', 'vision']});
  assert.ok(Number.isFinite(text) && text > 0);
  assert.ok(Number.isFinite(vision) && vision > text);
  assert.equal(estimateCallCost({preset: 'moonshot', model: 'kimi-k3.1-pro', capabilities: ['text', 'tools']}), null);
});
