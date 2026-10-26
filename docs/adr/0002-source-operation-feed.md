# 来源操作复用 source-check 任务，信息流是同一审计库的视图

## 状态

accepted（2026-10-27）

## 背景

来源操作需要登录、动作证据、抽取、复核、写库与撤销；应用已有 source-check 的任务卡、证据、外部复核、写网关与审计。另建一套任务生命周期会让两套状态、证据和撤销分叉。

## 决策

- 来源操作复用现有 source-check 任务：增加一个 operator 阶段，后续沿用截图→视觉抽取→外部复核→写网关→审计/撤销。
- 动作日志与每一步截图存任务证据（action JSONL + 截图），不单独建动作审计表；数据写入仍走 write_audit。
- 信息流 = 规范化 events/projects/companies + 来源证据指针 + append-only cursor；权威仍是本地审计库，不建 AI 私有库。
- MCP 工具 career_feed({since, types, sourceId, limit, includeRawText}) 返回规范化记录与增量；/chat 的 Agent 共用同一工具。
- 原始页面文本默认脱敏（手机号/邮箱/身份证/微信/联系人），单条 ≤8k 字；只有 includeRawText: true 才返回；不返回 HTML/截图字节。
- 证据 30 天后自动清理；feed 条目保留并返回 evidence_available: false，cursor 不倒退。
- feed 记录 upsert/delete/undo；撤销与软删除必须让下游 AI 看见。

## 后果

- 外部 AI 能看到脱敏原文与规范记录，但看不到原始 HTML/截图；需要原文全文时必须重新评估隐私边界。
- 30 天后证据不可用，但数据与 cursor 仍可消费；下游不能假设 evidence_ref 永久有效。
- 动作日志不是审计表，不能替代 write_audit；两套证据的职责要分清。
