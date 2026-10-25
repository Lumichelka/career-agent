// 内置价表：随版本发布、不联网，每条带来源与访问日期。
// 金额只用于展示与估算，一律标「≈¥」；价表没有的型号返回 null，调用记录只显示 tokens。

export const PRICE_VERSION = '2026-10-25.1';
export const USD_CNY = 7.2; // 固定汇率，不做实时换算

// currency 为供应商挂牌价币种；input/output 是每 1M token 单价。
// preset 为供应商预设；model 为 '*' 表示该预设下所有型号都按这个价（本机模型）。
export const PRICES = [
  // DeepSeek 低峰价；高峰为两倍。来源：DeepSeek Models & Pricing（访问 2026-10-25）
  {preset: 'deepseek', model: 'deepseek-flash', currency: 'USD', input: 0.15, output: 0.6, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', accessedAt: '2026-10-25', note: '低峰价；高峰（UTC 周一至周五 01:00-04:00、06:00-10:00）翻倍。'},
  {preset: 'deepseek', model: 'deepseek-v4-pro', currency: 'USD', input: 0.66, output: 1.98, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', accessedAt: '2026-10-25', note: '低峰价；纯文本，不支持图片。'},
  // 智谱 GLM 价格（CNY / 1M token）。来源：智谱 API 定价（访问 2026-10-25）
  {preset: 'zhipu', model: 'glm-5.3', currency: 'CNY', input: 8, output: 28, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-5.3-flash', currency: 'CNY', input: 0.8, output: 2.8, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25', note: '原生多模态。'},
  {preset: 'zhipu', model: 'glm-5.3-flashx', currency: 'CNY', input: 2, output: 7, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-5v-turbo', currency: 'CNY', input: 5, output: 22, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-4.6v', currency: 'CNY', input: 1, output: 3, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-4.6v-flashx', currency: 'CNY', input: 0.15, output: 1.5, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-4.6v-flash', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25', note: '免费视觉型号。'},
  {preset: 'zhipu', model: 'glm-4.5v', currency: 'CNY', input: 2, output: 6, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  {preset: 'zhipu', model: 'glm-4v-flash', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25', note: '免费视觉型号。'},
  {preset: 'zhipu', model: 'glm-4-flash-250414', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25', note: '免费文本型号。'},
  {preset: 'zhipu', model: 'glm-4.7-flash', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', accessedAt: '2026-10-25'},
  // 硅基流动（CNY / 1M token）。来源：硅基流动价格总览（访问 2026-10-25）
  {preset: 'siliconflow', model: 'zai-org/GLM-4.5V', currency: 'CNY', input: 1, output: 6, sourceUrl: 'https://www.siliconflow.cn/pricing', accessedAt: '2026-10-25'},
  {preset: 'siliconflow', model: 'zai-org/GLM-5.3-Flash', currency: 'CNY', input: 0.8, output: 2.8, sourceUrl: 'https://www.siliconflow.cn/pricing', accessedAt: '2026-10-25'},
  {preset: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', currency: 'CNY', input: 2, output: 8, sourceUrl: 'https://www.siliconflow.cn/pricing', accessedAt: '2026-10-25', note: '0-2 点、8-24 点价；2-8 点为半价。'},
  // 阿里云百炼（CNY / 1M token，取原价）。来源：百炼模型调用价格（访问 2026-10-25）
  {preset: 'qwen', model: 'qwen3.8-max', currency: 'CNY', input: 12, output: 36, sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', accessedAt: '2026-10-25'},
  {preset: 'qwen', model: 'qwen3.7-plus', currency: 'CNY', input: 2, output: 8, sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', accessedAt: '2026-10-25'},
  {preset: 'qwen', model: 'qwen3.8-flash', currency: 'CNY', input: 0.8, output: 2.7, sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', accessedAt: '2026-10-25'},
  {preset: 'qwen', model: 'qwen3.7-flash', currency: 'CNY', input: 0.2, output: 0.8, sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', accessedAt: '2026-10-25'},
  {preset: 'qwen', model: 'qwen-plus', currency: 'CNY', input: 0.8, output: 2, sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', accessedAt: '2026-10-25'},
  // 本机模型没有 API 费：按 0 元计，仍然算「有价」。
  {preset: 'ollama', model: '*', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://docs.ollama.com/api/openai-compatibility', accessedAt: '2026-10-25', note: '本机运行，无 API 费用；电费与硬件另计。'},
  {preset: 'lmstudio', model: '*', currency: 'CNY', input: 0, output: 0, sourceUrl: 'https://lmstudio.ai/docs/developer/openai-compat', accessedAt: '2026-10-25', note: '本机运行，无 API 费用；电费与硬件另计。'}
];

// 候选卡「约每次费用」的固定假设：常见一段任务的一次调用。
const ASSUMED_INPUT_TOKENS = 4000;
const ASSUMED_OUTPUT_TOKENS = 1000;
const ASSUMED_IMAGE_TOKENS = 1047;

export function priceFor({preset, model} = {}) {
  const p = String(preset || '');
  const m = String(model || '');
  if (!p) return null;
  return PRICES.find(entry => entry.preset === p && entry.model === m)
    || PRICES.find(entry => entry.preset === p && entry.model === '*')
    || null;
}

// usage: {input, output}；返回 {cny, estimated:true, priceVersion, sourceUrl}，未知价返回 null。
export function estimateCost({preset, model, usage} = {}) {
  const entry = priceFor({preset, model});
  if (!entry) return null;
  const input = Number(usage?.input);
  const output = Number(usage?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const rate = entry.currency === 'USD' ? USD_CNY : 1;
  const cny = ((input * entry.input + output * entry.output) / 1e6) * rate;
  return {
    cny,
    estimated: true,
    priceVersion: PRICE_VERSION,
    sourceUrl: entry.sourceUrl,
    currency: 'CNY',
    priceCurrency: entry.currency,
    accessedAt: entry.accessedAt
  };
}

// 统一的金额展示：永远带「≈¥」，未知/缺失返回空串。
export function formatCny(cny) {
  if (cny === null || cny === undefined || cny === '') return '';
  const n = Number(cny);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '≈¥0';
  const digits = n < 0.001 ? 6 : n < 0.01 ? 5 : n < 0.1 ? 4 : n < 1 ? 3 : 2;
  const text = n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return '≈¥' + text;
}

// 候选卡上的「约每次费用」：只用于排序与提示，与真实记账分开。
export function estimateCallCost({preset, model, capabilities = []} = {}) {
  const vision = Array.isArray(capabilities) && capabilities.includes('vision');
  const cost = estimateCost({
    preset,
    model,
    usage: {
      input: ASSUMED_INPUT_TOKENS + (vision ? ASSUMED_IMAGE_TOKENS : 0),
      output: ASSUMED_OUTPUT_TOKENS
    }
  });
  return cost ? cost.cny : null;
}
