# 来源 playbook

每个「AI 兜底」来源一份 Markdown 文件：`---` 包起来的 YAML front matter 是机器读的源知识，
正文给人评审。文件由 `src/source-check/playbook.mjs` 读取；没有 playbook 的源就没有 AI 兜底入口。

**这是兜底，不是自动采集（ADR 0003）。** 入口只在用户点击「AI 兜底」，或确定性采集失败/被阻断后
由用户手动选择时运行；不静默切换，也不定时运行。

## front matter 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | playbook id；通常与来源 id 相同（公众号统一用 `wechat`） |
| `title` | 建议 | 展示名；也用作 operator 关键截图标签 |
| `sourceIds` | 是 | 适用来源 id 列表；`wechat:<账号 id>` 按 `wechat` 匹配 |
| `aliases` | 否 | 来源别名（如 `swufe`），用于匹配 |
| `entry` | 是 | 入口 URL 列表，按顺序成为 operator 的 `goto` 步骤 |
| `detailSelector` | 兜底必填 | 列表页里进入详情的 CSS 选择器；有它在 `goto` 后生成一次 `click`，让兜底截到「列表 + 详情」两页。没有它或点击不跳转时，operator 会用 OPERATOR_SAME_PAGE 失败关闭，不写库 |
| `domains` | 是 | 允许域；至少覆盖入口主机。只作入口/登录域提示，**不做硬限制**（ADR 0001） |
| `successMarkers` | 是 | 可观察的成功标志；会真的拼进视觉抽取 prompt |
| `forbiddenActions` | 是 | 明确禁止的动作；按顿号/逗号切词后与 operator 的 DANGER_PATTERNS 合并，命中点击/按键即硬确认 |
| `extractHints` | 是 | 抽取提示（字段口径、缺字段留空、0 编造）；会真的拼进视觉抽取 prompt |
| `version` / `updatedAt` | 否 | 便于评审追踪 |

只支持 `key: 值`、`key: [a, b]`、`key:` + `- 列表项` 三种写法；不支持锚点、多行块与嵌套结构，
解析器遇到不认识的写法会忽略，不让它悄悄变成空配置。

**安全边界不是 playbook。** operator 按 ADR 0001 允许任意 Playwright/JS；`forbiddenActions` 与
`DANGER_PATTERNS` 只是对点击/按键/提交表单的尽力而为硬确认，页面里的 `evaluate`/任意 JS
仍然可以绕过。HTTP 入口已不再接受客户端 steps/evaluate；步骤只能来自服务端 playbook 或
进程内注入（公众号账号级 AI 采集）。

## 新增一份 playbook

1. 在来源的卡片/目录里确认来源 id 与入口 URL。
2. 复制现有文件改 front matter，正文写清入口、登录/人工接管、成功判定与边界。
3. 在 `tests/source-check-general.test.mjs` 的 playbook 测试里补上 id（该测试会校验字段齐全）。
