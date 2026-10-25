# 模型 API 的视觉输入、计价、限流与用量回传

> Wayfinder 研究票 [#17](https://github.com/Lumichelka/career-agent/issues/17)。
> 调研时间：2026-10-25。只取一手来源（供应商定价页、官方 API 文档、官方 FAQ）；**只记事实，不做产品决策**。
> 标注约定：`文档明确`＝一手文档写明；`推断`＝由一手材料组合推出；`未取得`＝本机取不到一手页面或页面由前端渲染为空；`无公开依据`＝没有任何官方材料。
> 价格均为**官方挂牌价，可能变动**；币种按各站原样标注（USD / CNY），不做汇率换算。
> 本机取证限制见 §1，直接影响 OpenAI、Anthropic、Gemini、火山方舟与 Dify/Coze 的结论。

## 0. 结论速览

1. **视觉正在并入主模型，但还没完全统一**：DeepSeek 的 `deepseek-flash`、智谱 GLM-5.3-Flash、Kimi K3.1 Pro、阿里 qwen3.8-max / qwen3.7-plus 都在同一个 OpenAI 兼容 `chat/completions` 里吃 `image_url`；智谱与阿里同时仍保留独立的视觉型号（`glm-4.6v`、`qwen3-vl-plus`）[2][8][12][18]。
2. **旧型号大面积下线**：`deepseek-chat` / `deepseek-reasoner` 已不在现行定价页；Kimi 的 `moonshot-v1-*-vision-preview` 于 2026-08-31 下线；智谱当前的免费文本型号是 `glm-4-flash-250414`。票里写的型号名需要按现行 ID 重核[1][11][6]。
3. **流式拿 usage 有三条不同路径**：DeepSeek 与 Kimi 要显式传 `stream_options.include_usage`；智谱不传也把 `usage` 放在最后一个 chunk；阿里 DashScope 原生响应额外给 `image_tokens`（OpenAI 兼容响应只给 prompt/completion/total）[3][14][9][18]。
4. **图片 token 上限差异很大**：DeepSeek 每图最多 **1024** token；硅基流动文档给出的 Qwen 系规则按 28px 网格折算，1440×900 约 **1716** token，1080×2400 约 **3354** token（`detail=high`）[2][20]。
5. **限流口径不同**：DeepSeek 只公布**并发数**（flash 2500 / pro 500），不公布 RPM/TPM；Kimi 按累计充值分档给 RPM/TPM/TPD；智谱与阿里的限流本轮未取到[4][16]。
6. **价格上最便宜的一档是"免费视觉型号"**：智谱 `glm-4.6v-flash`、`glm-4v-flash` 免费；阿里开通百炼后 90 天内有 100 万 token 免费额度（仅华北2 北京）[6][17]。
7. **OpenAI / Anthropic / Gemini / 火山方舟本轮无法取得一手价格页**：分别为 403、跨域重定向死循环、fetch 失败、页面空返回（§1）。这四家的数字一律不写，避免用二手价冒充官方。

## 1. 取证限制（影响结论范围）

| 目标 | 现象 | 处理 |
| --- | --- | --- |
| `platform.openai.com` / `developers.openai.com` | Cloudflare 403 "you have been blocked" | OpenAI 定价、模型、流式 usage 全部 `未取得`[29] |
| `docs.claude.com` → `platform.claude.com` → `www.anthropic.com` → `claude.com` | 跨域重定向链，工具不跟随 | Anthropic 定价 `未取得`；改用 `code.claude.com` 的 Claude Code 文档回答 Agent 部分[30][26] |
| `ai.google.dev` | `TypeError: fetch failed`（两次） | Gemini `未取得`[31] |
| `volcengine.com/docs/82379/1099320` → `docs.volcengine.com` | 返回 200 但正文为空（前端渲染） | 豆包 `未取得`[32] |
| `platform.kimi.com/docs/pricing/chat` | 价格表是前端组件，HTML 与 `.md` 都是空 `<table />` | Kimi 单价 `未取得`，只记计价口径[15] |
| `platform.kimi.com/docs/pricing/limits` | 限速表同为前端组件，空表 | Kimi 具体 RPM/TPM 数值 `未取得`[16] |
| `help.aliyun.com` 中文定价页 | 正文渲染失败；`.md` 版本可用 | 已用 `.md` 取得文本型号价格；视觉型号价格在页面后段被截断，`qwen3-vl-plus` 单价 `未取得`[17] |

## 2. 供应商 × 能力矩阵

| 供应商 | 兼容端点 | 图片输入 | 当前模型 ID（视觉相关） | 工具调用 | 结构化输出 | 流式 usage | 计价单位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com`[1] | 是 `文档明确`[2] | `deepseek-flash`（视觉）、`deepseek-v4-pro`（纯文本）[1] | 是，`strict` 为 Beta[3] | 仅 `json_object`，无 `json_schema`[3] | `stream_options.include_usage`[3] | USD / 1M token，峰谷两价[1] |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4`[9] | 是 `文档明确`[8] | `glm-5.3-flash`、`glm-5v-turbo`、`glm-4.6v`、`glm-4.6v-flash`、`glm-4.5v`、`glm-4v-flash`[6] | 是[8] | 是（结构化输出页）[8] | 最后 chunk 自带 `usage`[9] | CNY / 1M token[6] |
| Kimi | `https://api.moonshot.cn/v1`[12] | 是（base64 / `ms://`，不支持公网 URL）[12] | `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.6`[11] | 是[12] | `json_schema` + `strict`[12] | `stream_options.include_usage`[14] | 表格空，单价 `未取得`[15] |
| 阿里百炼 | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`[18] | 是 `文档明确`[18] | `qwen3.8-max`、`qwen3.7-plus`、`qwen3-vl-plus`[18][19] | `未核验`（本轮未取 Function Calling 页） | `未核验` | 非流式有 `usage`，原生响应含 `image_tokens`[18] | CNY / 1M token，阶梯价[17] |
| 硅基流动 | `https://api.siliconflow.cn/v1`[20] | 是 `文档明确`[20] | 聚合：`zai-org/GLM-4.5V`、`zai-org/GLM-5.3-Flash`、`Qwen/Qwen3.x` 等[21] | `未核验` | `未核验` | `未核验` | CNY / 1M token[21] |
| 火山方舟（豆包） | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得`[32] |
| OpenAI | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得`[29] |
| Anthropic | Messages 协议 `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得`[30] |
| OpenRouter | `https://openrouter.ai/api/v1`[24] | 是（URL 或 base64）[24] | 按上游模型，市场页逐个标价 | 官方有 Tool Calling 页（仅见目录） | 官方有 Structured Outputs 页（仅见目录） | 官方有 Usage Accounting 页（未逐页核验）[25] | 按模型计价 |
| Gemini | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得` | `未取得`[31] |
| Ollama（本机） | `http://localhost:11434/v1`[22] | 是（**仅 base64**，不支持图片 URL）[22] | 文档示例 `qwen3-vl:8b`；模型库自选[22] | 是；`tool_choice` 不支持[22] | JSON mode 是；JSON Schema `未核验` | `stream_options.include_usage`[22] | 本机算力，无 API 费 |
| LM Studio（本机） | `http://localhost:1234/v1`[23] | 是（Chat Completions 支持 images）[23] | 本地已下载模型，无固定 ID | 官方有 Tool Use 页[23] | 官方有 Structured Output 页[23] | `未核验` | 本机算力，无 API 费 |

## 3. 逐家明细

### 3.1 DeepSeek

- **型号与能力**：现行模型只有两个——`deepseek-flash`（DeepSeek-V4.1-Flash-1017，支持视觉）与 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813，**不支持视觉**）；上下文 1M，最大输出 384K。`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 作为旧名仍被接受，但请求由 Flash 承接并按 Flash 计价[1]。
- **票里写的 `deepseek-chat` / `deepseek-reasoner` 已不在现行定价页与 API 参考的 `model` 枚举中**（枚举只有 `deepseek-flash`、`deepseek-v4-pro`）[1][3]。
- **图片输入**：`content` 用块数组，支持 base64 data URL、公网 `http(s)` URL（≤8192 字符、≤32 MiB、60 秒内下载完）、Files API `file_id`（≤64 MiB）。单请求最多 600 张图，请求体上限 48 MiB，单边最大 8192px（≥15 张图时降为 4096px）。图片只能出现在 `user` 消息，放进 `system` / `assistant` 会 400[2]。
- **`detail` 语义**：`low` 先缩到 512×512；`high` / `original` / `auto` 保留原图（`auto` 当前等同 `original`）[2]。
- **图片 token**：按尺寸折算，先缩放到"总像素约等于 1300×1300"，**每图上限 1024 token**；2000×2000 与 5000×5000 缩放后同价[2]。官方只给上限与缩放规则，不给线性公式；按像素比例推算 1440×900 ≈ 785 token 属 `推断`。
- **工具与 JSON**：`tools` 支持 function calling，`strict` 为 Beta；`response_format` 只接受 `text` / `json_object`，**没有 `json_schema`**。思考模式下 `tool_choice` 的 `required` 与指定函数会 400[3]。
- **usage**：`usage` 含 `prompt_tokens`、`completion_tokens`、`total_tokens`，以及 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`。流式下 `stream_options.include_usage=true` 让每个 chunk 带 `usage` 字段（除最后一块外为 `null`）；不传时只有最后一个内容 chunk 带 `usage`，**不会单独发 usage-only chunk**[3]。
- **计价（USD / 1M token，挂牌价）**[1]：

| 项目 | flash 低峰 | flash 高峰 | v4-pro 低峰 | v4-pro 高峰 |
| --- | --- | --- | --- | --- |
| 输入（缓存命中） | $0.003 | $0.006 | $0.022 | $0.044 |
| 输入（缓存未命中） | $0.15 | $0.3 | $0.66 | $1.32 |
| 输出 | $0.6 | $1.2 | $1.98 | $3.96 |

  高峰为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（中国法定节假日除外），其余时段及周末为低峰，低峰价是高峰的一半[1]。
- **限流**：不按 RPM/TPM，按**账号级并发**：flash 2500、v4-pro 500；超限 429。可提扩容申请，不额外收费。`user_id` 只做隔离与调度，普通账号所有 `user_id` 合并计算并发[4]。
- **连接行为**：请求可能长时间无响应，服务端持续回空行或 `: keep-alive`；**若 10 分钟未开始推理，服务端关闭连接**[4]。这条直接决定"超时"该设在哪。

### 3.2 智谱 GLM

- **价格表（CNY / 1M token）**（节选，均为挂牌价）[6]：

| 模型 | 上下文 | 输入 | 输出 | 缓存命中 |
| --- | --- | --- | --- | --- |
| `glm-5.3` | 1M | 8 | 28 | 2 |
| `glm-5.3-flash` | 1M | 0.8 | 2.8 | 0.23 |
| `glm-5.3-flashx` | 1M | 2 | 7 | 0.57 |
| `glm-5v-turbo` | <32K | 5 | 22 | 1.2 |
| `glm-4.6v` | <32K | 1 | 3 | 0.2 |
| `glm-4.6v-flashx` | <32K | 0.15 | 1.5 | 0.03 |
| `glm-4.6v-flash` | — | 免费 | 免费 | 免费 |
| `glm-4.5v` | <32K | 2 | 6 | 0.4 |
| `glm-4v-flash` | 4K | 免费 | 免费 | 不支持 |
| `glm-4-flash-250414` | 128K | 免费 | 免费 | 不支持 |
| `glm-4.7-flash` | 200K | 免费 | 免费 | 免费 |

- 价格页明确"模型价格统一按元/百万 Tokens 展示；图片、视频、语音若按次/分钟/字符计费会单独标注"[6]。
- **图片 token**：官方 FAQ 写明"调用 GLM-4V 系列图像识别模型时，**单张图片大约消耗 1047 个 tokens**"[10]。该口径只覆盖 GLM-4V 系列；GLM-5V / 4.6V 的折算规则本轮未取到。
- **多模态型号**：`glm-5.3-flash` 为原生多模态（图片、视频、文件、文本输入），1M 上下文、128K 输出；图片参数是在 `messages[].content[]` 放 `type: image_url`，`image_url.url` 传 URL 或 Base64 Data URL，可多图[8]。
- **流式 usage**：官方写明 `usage` "仅在最后一个 chunk 中出现"，示例里最后一个 chunk 同时带 `finish_reason` 与 `usage`，**不需要 `stream_options`**[9]。
- **工具/结构化**：GLM-5.3-Flash 页面列出 Function Calling、结构化输出、上下文缓存、思考模式；`thinking.type` 只支持 `enabled`（不能关思考）[8]。
- **限流**：本轮未取到官方 RPM/TPM 页 → `未取得`。
- **计费注意**：缓存存储当前"限时免费"，页面未给免费期结束后的价格[6]。

### 3.3 月之暗面 Kimi

- **型号**：`kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`；K2 系列 2026-10-31 起停止向新用户开放，计划 2026 年 12 月底全部下线[11][15]。
- **旧视觉型号已下线**：`moonshot-v1-8k/32k/128k-vision-preview` 于 2026-08-31 下线；`kimi-latest` 于 2026-01-28 下线[11]。
- **视觉输入**：`content` 必须是对象数组；本地图片用 base64 data URL，视频/文件用 `ms://<file-id>`；**视觉输入不支持公网图片 URL**[12]。
- **能力**：1M 上下文，`reasoning_effort` 三档（low/high/max，默认 max），**思考模式始终开启、不能关**；`max_completion_tokens` 默认 131072、最大 1048576；`temperature`、`top_p`、`n` 等为固定值，建议不要显式传[12]。
- **工具/结构化**：`tools` + `tool_choice`（首轮可用 `required`）；结构化输出用 `response_format: {type: "json_schema", json_schema: {strict: true, ...}}`，只解析 `message.content`，不解析 `reasoning_content`[12]。
- **流式 usage**：传 `stream_options: {"include_usage": true}` 后，服务端在 `[DONE]` 前返回一个 **`choices` 为空、顶层带 `usage`** 的独立统计块；官方特别提醒"不要假设每个 chunk 都有 `choices[0]`"，且应以 `data: [DONE]` 判断结束[14]。
- **计价**：价格页存在，但 K3/K2 两张表都是空 `<table />`（前端组件），**单价 `未取得`**[15]。计价口径为：输入分缓存命中/未命中，K3 系列另收缓存写入费（TTL 5min / 1h 两档）[15]。
- **限流**：按账户累计充值金额分档，维度含并发、RPM、TPM、TPD；**具体档位表同样是空表，`未取得`**。超限返回 429，带 `X-RateLimit-Limit/Remaining/Reset`[16]。
- **接入条件**：K3.1 Pro / K3 需充值（最低 10 元）解锁，新用户 15 元代金券不可用于这两个旗舰模型[12][13]。

### 3.4 阿里云百炼 Qwen

- **接入点**：OpenAI 兼容 `base_url` 是 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，按地域与业务空间不同[18]。
- **当前型号**：文本/多模态主力 `qwen3.8-max`、`qwen3.7-plus`、`qwen3.8-flash`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.5-plus`、`qwen-plus`；视觉侧文档点名 `qwen3-vl-plus`、`qwen3.8-max`、`qwen3.7-plus` 可用于图像问答[18][19]。
- **价格（CNY / 1M token，挂牌价，阶梯计价；部分地域限时 8 折，表中取原价）**[17]：

| 模型 | 输入区间 | 输入 | 输出（非思考） | 输出（思考） |
| --- | --- | --- | --- | --- |
| `qwen3.8-max` | 0–1M | 12 | 36 | 36 |
| `qwen3.7-plus` | 0–256K | 2 | 8 | 8 |
| `qwen3.6-plus` | 0–256K | 2 | 12 | 12 |
| `qwen-plus` | 0–128K | 0.8 | 2 | 8 |
| `qwen-plus` | 128K–256K | 2.4 | 20 | 24 |
| `qwen-plus` | 256K–1M | 4.8 | 48 | 64 |
| `qwen3.8-flash` | 0–1M | 0.8 | 2.7 | 2.7 |
| `qwen3.7-flash` | 0–32K | 0.2 | 0.8 | 0.8 |
| `qwen3.7-flash` | 32K–256K | 0.6 | 2.4 | 2.4 |
| `qwen3.7-flash` | 256K–1M | 1.2 | 4.8 | 4.8 |

- **阶梯规则**：单价由**单次请求的输入 token 总量**决定，命中哪一档，该请求全部 token 都按该档结算（例：输入 100K 落在 32K–128K 档，全部按第二档）[17]。
- **免费额度**：部分模型仅在**华北2（北京）**有免费额度，100 万 token，自开通/发布/申请通过起 90 天内有效[17]。
- **图片 token**：视觉文档的 DashScope 原生示例响应里 `usage` 为 `{output_tokens, input_tokens, image_tokens}`；同一页的 OpenAI 兼容示例只返回 `prompt_tokens` / `completion_tokens` / `total_tokens`。但"图像限制 / 折算公式"一节在抓取时被截断，**官方公式本轮 `未取得`**[18]。
- **可替代口径（非阿里官方）**：硅基流动文档给出的 Qwen 系折算规则是"长宽各向上取整到 28 的倍数，token = (H/28)×(W/28)"，`detail=low` 统一 256 token；这是转售平台的官方文档，不是阿里原文[20]。
- **思考模式**：`qwen3.8/3.7/3.6/3.5` 与 `qwen3-vl-plus` 为混合思考，`enable_thinking` 控制；`qwen3-vl-plus` 默认 `false`，其余默认 `true`；带 `thinking` 后缀的型号不能关[18]。

### 3.5 硅基流动 SiliconFlow

- **视觉输入**：`/chat/completions` 里放 `image_url`（URL 或 base64），`detail` 取 `low/high/auto`；`detail` 不传或传 `high` 时走高分辨率，`low`/`auto` 走低分辨率[20]。
- **图片 token 公式（官方，分模型族）**：
  - Qwen 系：像素区间 3136–12845056，长宽先按 28 的倍数向上取整；`detail=low` 缩到 448×448 → **256 token**；`detail=high` → `(H/28)×(W/28)`。示例：1024×1024 → 1036×1036 → 1369 token[20]。
  - DeepseekVL2 系：`(h*w+1)*196 + (w+1)*14 + 1`，`detail=low` 固定 421 token[20]。
  - GLM-4.1V-9B-Thinking：与 Qwen 同为 28 网格，`detail=low` 256 token[20]。
- **价格（CNY / 1M token，挂牌价，节选）**[21]：`zai-org/GLM-4.5V` 输入 1 / 输出 6；`zai-org/GLM-5.3-Flash` 0.8 / 2.8 / 缓存 0.23；`deepseek-ai/DeepSeek-V4.1-Flash` 分时段 2 / 8（0–2 点、8–24 点）与 1 / 4（2–8 点），缓存 0.04 / 0.02；`moonshotai/Kimi-K2.7-Code` 6.5 / 27。
- **免费模型**：`tencent/Hunyuan-MT-7B` 标"免费"[21]。
- **工具调用 / 结构化输出 / usage**：本轮未逐页核验 → `未核验`。

### 3.6 火山方舟（豆包）

`未取得`。定价页重定向到 `docs.volcengine.com` 后返回 200 但正文为空（纯前端渲染），无法取得任何一手数字或型号 ID[32]。本轮**不引用**任何第三方价格。

### 3.7 OpenAI

`未取得`。`platform.openai.com` 与 `developers.openai.com` 均返回 Cloudflare 403（"you have been blocked"），与仓库既有研究遇到的情况一致[29]。模型 ID、图片 token 公式、`stream_options.include_usage`、Batch 折扣等本轮均无法核验。

### 3.8 Anthropic（Messages 协议）

`未取得`。官方定价页在 `docs.claude.com` → `platform.claude.com` → `www.anthropic.com` → `claude.com` 之间重定向，抓取工具不跟随跨域跳转，最终只拿到 `claude.com/pricing` 的导航壳，API 价格表在 JS 标签页里未渲染[30]。可从 `code.claude.com` 侧证的相关事实见 §5。

### 3.9 OpenRouter

- **图片输入**：`/api/v1/chat/completions` 的 `messages` 支持多段 content，`image_url` 可为公网 URL 或 base64；支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`；单请求图片数量"因供应商与模型而异"；官方建议**先放文本提示、再放图片**[24]。
- **工具/结构化**：文档目录存在 Tool Calling（Client Tools）与 Structured Outputs 页面，本轮只看到目录项，未逐页核验具体字段。
- **用量与成本**：官方文档目录存在 Usage Accounting 页面（实际路径在 cookbook 下），本轮未逐页核验其字段与返回位置[25]。
- **计价**：按上游模型逐个标价，属于聚合层，价格随上游变动，本轮未逐模型抄录。

### 3.10 Google Gemini

`未取得`。`ai.google.dev` 两次 `fetch failed`，OpenAI 兼容层与定价页均未取到[31]。

### 3.11 本机 Ollama

- **OpenAI 兼容端点**：`http://localhost:11434/v1`，API key 必填但被忽略[22]。
- **能力清单（官方勾选表）**：Chat completions ✓、Streaming ✓、JSON mode ✓、Vision ✓、Tools ✓、Reasoning/thinking 控制 ✓；Logprobs ✗[22]。
- **视觉限制**：`Image content` 勾选 **Base64 encoded image**，**不勾选 Image URL**——本机 Ollama 的兼容层不接受图片 URL[22]。
- **请求字段**：`stream_options.include_usage` ✓；`tools` ✓；`tool_choice` ✗；`user` ✗；`n` ✗[22]。
- **模型**：文档视觉示例用 `qwen3-vl:8b`；Responses API 示例用 `qwen3:8b`、`gpt-oss:20b`。具体可用视觉模型需按本机 `ollama list` 为准[22]。

### 3.12 本机 LM Studio

- **OpenAI 兼容端点**：`http://localhost:1234/v1`，覆盖 `/v1/models`、`/v1/responses`、`/v1/chat/completions`、`/v1/embeddings`、`/v1/completions`[23]。
- **图片**：官方把 Chat Completions 描述为 "Chat Completions (text and images)"，即兼容层支持图片输入[23]；具体 content part 形状本轮未逐页核验。
- **工具/结构化**：文档目录存在 Tool Use 与 Structured Output 页面[23]。
- **模型 ID**：无固定清单，用 LM Studio 里已加载模型的标识符[23]。

## 4. 场景估账

### 4.1 假设与算式

- 截图场景：`输入 = 8000 文本 token + 1 张图`，`输出 = 1500 token`。
- 文本场景：3 次调用合计 `输入 20000`、`输出 4000`。
- 图片 token 估算：
  - DeepSeek：`min(1024, 1024 × 像素数 / 1,690,000)`；1440×900=1,296,000 → ≈ **785**（`推断`）；1080×2400=2,592,000 → 触顶 **1024**[2]。
  - Qwen / 硅基流动 `detail=high`：`ceil(W/28) × ceil(H/28)`；1440×900 → 52×33 = **1716**；1080×2400 → 39×86 = **3354**；`detail=low` 均 **256**[20]。
  - 智谱 GLM-4V 系：官方"约 **1047** token/图"[10]。
- 计价公式：`费用 = 输入token × 输入单价 / 1e6 + 输出token × 输出单价 / 1e6`。

### 4.2 截图场景（1 图 + 8k 文本 + 1.5k 输出）

| 候选 | 图片 token | 输入 token | 输入费 | 输出费 | 合计 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash` 低峰 | 785 | 8785 | $0.00132 | $0.00090 | **$0.00222**（≈0.0022 美元） | 高峰翻倍 → $0.00443[1] |
| DeepSeek `deepseek-flash` 1080×2400 | 1024 | 9024 | $0.00135 | $0.00090 | **$0.00225** | 同上，高峰 $0.00451[1] |
| 智谱 `glm-5.3-flash` | 1047 | 9047 | ¥0.00724 | ¥0.00420 | **¥0.0114** | 缓存命中输入价 0.23[6] |
| 智谱 `glm-4.6v` | 1047 | 9047 | ¥0.00905 | ¥0.00450 | **¥0.0135** | <32K 档[6] |
| 智谱 `glm-5v-turbo` | 1047 | 9047 | ¥0.04524 | ¥0.03300 | **¥0.0782** | <32K 档[6] |
| 智谱 `glm-4.6v-flash` | 1047 | 9047 | ¥0 | ¥0 | **¥0** | 免费型号[6] |
| 阿里 `qwen3.8-max` | 未取得 | 8000（不含图） | ¥0.09600 | ¥0.05400 | **≥¥0.1500** | 图片 token 未知，实际更高[17][18] |
| 阿里 `qwen3.8-flash` | 未取得 | 8000（不含图） | ¥0.00640 | ¥0.00405 | **≥¥0.0105** | 图片 token 未知，实际更高[17] |
| 硅基流动 `zai-org/GLM-4.5V` | 1716 | 9716 | ¥0.00972 | ¥0.00900 | **¥0.0187** | 28 网格公式[20][21] |
| 本机 Ollama / LM Studio | — | — | 0 | 0 | **0（电费/硬件另计）** | [22][23] |

Kimi、OpenAI、Anthropic、Gemini、豆包因单价 `未取得`，无法给出数字。

### 4.3 文本三连（20k 输入 / 4k 输出）

| 候选 | 输入费 | 输出费 | 合计 |
| --- | --- | --- | --- |
| DeepSeek `deepseek-flash` 低峰 | $0.0030 | $0.0024 | **$0.0054** |
| DeepSeek `deepseek-flash` 高峰 | $0.0060 | $0.0048 | **$0.0108** |
| DeepSeek `deepseek-v4-pro` 低峰 | $0.0132 | $0.0079 | **$0.0211** |
| DeepSeek `deepseek-v4-pro` 高峰 | $0.0264 | $0.0158 | **$0.0422** |
| 智谱 `glm-5.3` | ¥0.160 | ¥0.112 | **¥0.272** |
| 智谱 `glm-5.3-flash` | ¥0.016 | ¥0.0112 | **¥0.0272** |
| 智谱 `glm-4.7-flash` | ¥0 | ¥0 | **¥0** |
| 阿里 `qwen-plus`（非思考） | ¥0.016 | ¥0.008 | **¥0.024** |
| 阿里 `qwen-plus`（思考） | ¥0.016 | ¥0.032 | **¥0.048** |
| 阿里 `qwen3.8-max` | ¥0.240 | ¥0.144 | **¥0.384** |
| 阿里 `qwen3.8-flash` | ¥0.016 | ¥0.0108 | **¥0.0268** |

（单位：DeepSeek 为 USD，其余为 CNY；价格均来自 §3 的挂牌价，未含缓存与 Batch 折扣[1][6][17]。）

### 4.4 读账时要注意的三件事

1. **缓存会显著改价**：DeepSeek flash 缓存命中 $0.003 vs 未命中 $0.15（低峰），差 50 倍；智谱 0.23 vs 0.8[1][6]。
2. **阶梯价按"单次请求输入总量"整体结算**，不是分段累加；长上下文请求会整体跳到高档[17]。
3. **思考 token 计入输出**：DeepSeek 的 `completion_tokens_details.reasoning_tokens`、Kimi/智谱的思考模式都会把推理过程算进输出 token[3][12][8]。

## 5. 延迟

能拿到的一手量级（**没有任何官方 p50/p95 延迟承诺**）：

- Kimi 官方：完整回复"通常要数秒"，问题复杂或回复较长时"可能拉长到 10 秒甚至 20 秒"；开流式后首个 token 可更早到达[14]。
- 智谱 `glm-5.3-flashx`：官方标称推理速度 **200 tokens/s**[8]。
- DeepSeek：不公布延迟；只说明"若 10 分钟未开始推理，服务端关闭连接"，以及等待期发 keep-alive[4]。
- 其余供应商（阿里、硅基流动、OpenRouter、Ollama、LM Studio、OpenAI、Anthropic、Gemini、豆包）：**未找到官方首 token / 整响应延迟数据**（`未找到`）。

> 可用于定超时的只有两条硬事实：DeepSeek 的 10 分钟"未开始推理"上限，以及 Kimi 的"复杂回答 10–20 秒"经验描述[4][14]。p95 级数据在本轮一手来源中不存在。

## 6. 外部 Agent 的视觉事实

| 对象 | 能否接收图片 / 是否支持视觉 | 依据 |
| --- | --- | --- |
| Claude Code（作为 MCP 客户端） | 交互式会话可接收截图：官方"降低成本"页建议把截图粘进 prompt 当作验证目标[28] | `文档明确`（交互输入），但**不是 MCP 协议层证据** |
| `claude mcp serve`（把 Claude Code 暴露为 stdio MCP Server） | **未找到现行文档**：CLI 参考只列 `claude mcp`（add/list/get/remove/login/logout），没有 `serve` 子命令；MCP 参考页也只讲"作为客户端连接别人"[27][26] | `未找到` / `无公开依据` |
| Codex CLI | **未取得**：`openai.com`、`developers.openai.com` 均 403，GitHub 在本机不可达[29] | `无公开依据`（本轮） |
| Dify MCP Server | 本轮未取证 | `无公开依据`（本轮） |
| Coze MCP Server | 本轮未取证 | `无公开依据`（本轮） |

能确认的只有一点：MCP 工具结果是否可含图片块，取决于具体 Server 的实现文档；本轮没有拿到 Claude Code `mcp serve`、Dify、Coze 的任何一手实现文档，因此不下结论。

## 7. 对决策的含义（只列事实，不做产品选择）

- **视觉越来越多地由主模型直接承担**：DeepSeek flash、GLM-5.3-Flash、Kimi K3.1 Pro、qwen3.8-max/qwen3.7-plus 都是同一端点同一模型名吃图；真正的差异在**图片 token 上限**（DeepSeek 1024/图 vs Qwen 可到数千/图）与**是否支持公网图片 URL**（Kimi 不支持、Ollama 不支持、DeepSeek/阿里/硅基流动支持）[2][20][12][22]。
- **票里写的模型 ID 多数已过期**：`deepseek-chat`/`deepseek-reasoner`、`moonshot-v1-*-vision-preview`、`glm-4-flash` 都不是现行文档里的写法；若代码里硬编码这些名字，需要迁移[1][11][6]。
- **usage 不是统一行为**：智谱"最后一块自带"，DeepSeek/Kimi"要显式开 include_usage 且最后一块可能是独立块"，阿里原生响应还多一个 `image_tokens` 字段；调用记录若只读 `usage.total_tokens`，在 Kimi 上会漏掉那个 `choices` 为空的统计块[9][3][14][18]。
- **限流维度不可比**：DeepSeek 只有并发（2500/500），Kimi 按充值分档 RPM/TPM/TPD，智谱与阿里本轮未取到；"每分钟请求数"这个统一阈值在四家之间无法直接对齐[4][16]。
- **成本量级**：截图场景下，最便宜的云端选项是智谱免费视觉型号（¥0）与 DeepSeek flash 低峰（约 $0.0022）；同一场景 `qwen3.8-max` 至少 ¥0.15（不含图片 token），差约两个数量级[6][1][17]。
- **超时上限有官方锚点**：DeepSeek 明确"10 分钟未开始推理即断连"，Kimi 描述复杂回答 10–20 秒；其余家没有可引用的 p95[4][14]。
- **外部 Agent 的视觉能力在本轮无法作为方案前提**：`claude mcp serve` 的现行文档不存在，Codex/Dify/Coze 未取证；把它们当作"能读图的外部 Agent"目前没有一手依据[27][26]。

## 8. 未查到清单（按重要性）

1. **Kimi 单价与限流档位**：页面存在但表格是前端组件，静态抓取为空[15][16]。需要浏览器渲染或官方 PDF/公告。
2. **智谱 RPM/TPM**：未找到独立限流文档。
3. **阿里视觉型号（`qwen3-vl-plus`）单价与图片 token 公式**：定价页后段被截断，视觉文档"图像限制"节被截断[17][18]。
4. **OpenAI / Anthropic / Gemini / 火山方舟的全部数字**：403、重定向死循环、fetch 失败、空页面[29][30][31][32]。
5. **`claude mcp serve` 是否存在**：CLI 参考无此子命令，MCP 页只讲客户端[27][26]。
6. **Codex CLI / Dify / Coze 的图片能力**：未取证。
7. **任何官方 p50/p95 延迟**：全部 `未找到`。
8. **DeepSeek 图片 token 的精确线性公式**：官方只给"约 1300×1300 像素对应上限 1024"与缩放规则[2]。

## 9. 来源

1. DeepSeek — Models & Pricing：<https://api-docs.deepseek.com/quick_start/pricing>
2. DeepSeek — Vision（图片格式、三种传法、detail、每图 1024 token 上限、限制）：<https://api-docs.deepseek.com/guides/vision>
3. DeepSeek — Chat Completions API（`response_format`、`tools.strict`、`stream_options.include_usage`、usage 字段）：<https://api-docs.deepseek.com/api/create-chat-completion>
4. DeepSeek — Rate Limit & Isolation（并发 2500/500、10 分钟未推理断连）：<https://api-docs.deepseek.com/quick_start/rate_limit>
5. DeepSeek — Token & Token Usage（token 换算、图片 token 计算器入口）：<https://api-docs.deepseek.com/quick_start/token_usage>
6. 智谱 — API 定价（文本/视觉/免费型号、缓存价）：<https://docs.bigmodel.cn/cn/guide/start/pricing>
7. 智谱 — 模型概览（当前核心型号与上下文）：<https://docs.bigmodel.cn/cn/guide/start/model-overview>
8. 智谱 — GLM-5.3-Flash / FlashX（原生多模态、图片参数、Function Calling、结构化输出、200 tokens/s）：<https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash>
9. 智谱 — 流式消息（usage 仅在最后一个 chunk）：<https://docs.bigmodel.cn/cn/guide/capabilities/streaming>
10. 智谱 — 费用问题 FAQ（GLM-4V 单图约 1047 token）：<https://docs.bigmodel.cn/cn/faq/fee-issues>
11. Kimi — 模型列表（K3.1 Pro/K3/K2.6、旧型号下线日期）：<https://platform.kimi.com/docs/models>
12. Kimi — Kimi K3.1 Pro（视觉输入限制、工具、json_schema、reasoning_effort、max_completion_tokens）：<https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart>
13. Kimi — Kimi K3（视觉、工具、结构化输出、充值门槛）：<https://platform.kimi.com/docs/guide/kimi-k3-quickstart>
14. Kimi — 流式输出（include_usage、独立统计块、`[DONE]`、10–20 秒经验）：<https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api>
15. Kimi — 模型推理价格说明（计价口径；表格为空）：<https://platform.kimi.com/docs/pricing/chat>
16. Kimi — 充值与限速（按累计充值分档；表格为空）：<https://platform.kimi.com/docs/pricing/limits>
17. 阿里云百炼 — 模型调用价格（qwen 系列阶梯价、免费额度、阶梯规则）：<https://help.aliyun.com/zh/model-studio/model-pricing>
18. 阿里云百炼 — 图像与视频理解（OpenAI 兼容示例、`image_tokens`、enable_thinking）：<https://help.aliyun.com/zh/model-studio/vision>
19. 阿里云百炼 — 选择模型（当前推荐型号）：<https://help.aliyun.com/zh/model-studio/models>
20. 硅基流动 — 视觉语言模型（detail、Qwen/DeepseekVL2/GLM-4.1V 的图片 token 公式）：<https://docs.siliconflow.cn/cn/userguide/capabilities/vision>
21. 硅基流动 — 价格总览（GLM-4.5V、GLM-5.3-Flash、DeepSeek-V4.1-Flash 等）：<https://www.siliconflow.cn/pricing>
22. Ollama — OpenAI compatibility（Vision 仅 base64、tools、JSON mode、include_usage、tool_choice 不支持）：<https://docs.ollama.com/api/openai-compatibility>
23. LM Studio — OpenAI Compatibility Endpoints（本地 1234 端口、chat completions 文本与图片）：<https://lmstudio.ai/docs/developer/openai-compat>
24. OpenRouter — Image Inputs（URL/base64、支持格式、先文后图）：<https://openrouter.ai/docs/guides/overview/multimodal/image-understanding>
25. OpenRouter — Usage Accounting（用量与成本回传；目录页）：<https://openrouter.ai/docs/cookbook/administration/usage-accounting>
26. Claude Code — Connect Claude Code to tools via MCP（客户端配置；无 serve 子命令）：<https://code.claude.com/docs/en/mcp>
27. Claude Code — CLI reference（`claude mcp` 子命令清单）：<https://code.claude.com/docs/en/cli-reference>
28. Claude Code — Manage costs effectively（"paste screenshots"、按 token 计费、TPM/RPM 建议）：<https://code.claude.com/docs/en/costs>
29. OpenAI — Pricing（Cloudflare 403，未取得）：<https://platform.openai.com/docs/pricing>
30. Anthropic — Pricing（跨域重定向，未取得）：<https://platform.claude.com/docs/en/about-claude/pricing>
31. Google — Gemini API Pricing（fetch failed，未取得）：<https://ai.google.dev/gemini-api/docs/pricing>
32. 火山方舟 — 模型服务计费（重定向后正文为空，未取得）：<https://www.volcengine.com/docs/82379/1099320>
