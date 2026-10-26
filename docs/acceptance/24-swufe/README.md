# 24 · 西南财大首个端到端验收证据包（live 2026-10-26）

> 对应 spec [#25](https://github.com/Lumichelka/career-agent/issues/25) / ticket [#42](https://github.com/Lumichelka/career-agent/issues/42)，执行口径见 [docs/plan/24-首个端到端验收规格.md](../../plan/24-首个端到端验收规格.md)。
>
> **当前状态：live 已执行（2026-10-26），证据包校验通过（含已知偏差）。** 本页与 `manifest.json` 记录本次真实运行；
> 不得把确定性回归测试输出、示例值或占位符当成验收证据，**不得伪造**路径、哈希、截图与签字。

## 0. 证据包、确定性回归与 live 的边界

- `tests/acceptance-swufe.test.mjs` 是**确定性回归**：临时数据目录、固定抽取 fixture、本地假浏览器/假视觉/假 MCP Agent，不联网、不调视觉 API。
  它证明代码链路可重复，**不等于** live 验收。
- live 验收必须由 owner 在本机真实执行一次：真实 Edge 浏览器两次读取、真实视觉模型 API 抽取、真实外部 Agent 复核一次成功。
- 本次 live 已通过（含已知偏差），`manifest.json` 为 `passed`，签字区写「验收通过（含已知偏差） + 日期」。
- 本次 live 为复用已有视觉 Key，显式使用 `MODEL_VAULT_DIR` 复制 `model-settings.json` / `secrets.enc.json` / `vault.key` 到临时目录；未复制简历/投递/采集库，运行结束删除密钥副本。复核 Agent 是 `claude -p --tools ""` 的本地 MCP 桥，不是 `claude mcp serve`。两处都是与严格 §2 的已知偏差。
- 原始页面截图（`01-list.png` / `02-detail.png`）可能含联系方式：**只记本机路径 + sha256，不复制进仓库**。

## 1. 证据目录约定

```
docs/acceptance/24-swufe/
├── README.md                      # 本证据包说明（owner 已填表与签字）
├── manifest.template.json         # 证据清单模板；复制为 manifest.json 后填写
├── verify-evidence.mjs            # 校验器：路径/哈希/计数/联系方式/撤销一致性
└── evidence/                      # live 完成后创建；只放已脱敏的副本
    ├── extraction.json            # 抽取结果（联系方式已剔除）
    ├── review.json                # 外部 Agent 复核输出（问题列表或原始文本）
    ├── audit-export.json          # 审阅层「导出 JSON」得到的审计导出
    ├── task.json                  # 复制自 users/<userId>/tasks/<taskId>.json 的任务日志
    ├── recruit.db.before          # 验收前 DB 快照（SQLite backup / checkpoint 后复制）
    ├── recruit.db.after           # 写库后、撤销前 DB 快照
    ├── recruit.db.after-undo      # 干净撤销后 DB 快照
    ├── ui-task-card.png           # 任务卡（成功 + 批次数 + 证据）
    ├── ui-audit-review.png        # 审阅层批次 diff
    └── ui-force-confirm.png       # 强制撤销二次确认（当前值 / 写回值 / 覆盖后果）
```

原始页面截图留在本机任务证据目录：
`<CAREER_DATA_DIR>/users/<userId>/tasks/<taskId>/evidence/01-list.png` 与 `02-detail.png`，
本页只记录它们的实际路径与 sha256。

## 2. live 检查清单（owner）

- [x] 使用**空的临时** `CAREER_DATA_DIR`；本次为复用已有视觉 Key，显式复制 `model-settings.json` / `secrets.enc.json` / `vault.key`，未复制业务库，结束后删除密钥副本。
- [x] `npm start` 正常启动；登录 owner，记录 `userId`。
- [x] 视觉模型为 `deepseek-flash`，Key 来自本机已有 KeyVault（显式复制，见上）。
- [x] 文本/视觉共用 `deepseek-flash` API。
- [x] 外部 Agent 为 `claude-review`（`claude -p --tools ""` 的本地 MCP 桥），测试连接 `legacy/modern` 通过，复核工具名 `review`。
- [x] 本机 Microsoft Edge 可用；未启用 stealth / 反检测，未伪装 UA。
- [x] `swufe` 采集器仍为 `enabled:false`；未运行 `runCollection`，未改采集器配置。
- [x] 无并发任务；干净用例 51.6 秒，冲突用例亦在 15 分钟内。
- [x] commit `1119866`、Node `v24.18.0`、Edge `150.0.4078.65` 已写入 manifest。
- [x] `recruit.db.before` 已落 `evidence/`，内容哈希 `af3381…`。

## 3. live 执行步骤（逐条勾选）

1. [x] 来源校对任务已发起；本次 live 经 `/api/source-check/start` 发起，来源卡入口由确定性 Playwright 覆盖；任务提示「采集器禁用，改用浏览器读取」。
2. [x] 应用内浏览器只打开列表页与一场活动详情各一次，各截图一次；不翻页、不并发、不绕过登录/验证；详情页页内点开「参会企业」页签后截图。
       记录两次读取的 URL、页面标题、时间与视口（`screenshots.json`）。
3. [x] 视觉模型 API 只依据两张截图抽取，产出 `extraction.json`：本次列表 3 场活动均写入、单位 10 家、读不到留空；非匹配活动 sourceUrl 留空（review low）；
       联系方式 0 条（任务卡证据标「抽取 JSON（联系方式已剔除）」）。
4. [x] 外部 Agent 只收到抽取 JSON 与来源元数据做文本复核，产出 `review.json`（7 个问题：2 个 high 截断单位名、3 个 medium 标题/场地截断、2 个 low 非匹配活动 sourceUrl 留空）；
       问题只作建议，**写入集未被修改**；若复核不可用，本项记未通过，不得签「验收通过」。
5. [x] 写库后核对：只写 `events` / `event_projects`；`source_id='manual'`；`source_url` 只记录；
       `notes` 标「浏览器截图读取（非采集器）」；`company.db` 未创建；无重复活动/单位；联系方式 0 条入库。
6. [x] 审计核对：13 行数据 / 13 行审计 1:1；同任务同批次；`actor_type=model_api`；`source_ref` 指向详情截图；
       old/new 整行；导出 `audit-export.json`。
7. [x] `recruit.db.after` 已落 `evidence/`，内容哈希 `85b58b…`。
8. [x] 任务级撤销：已撤销 13 行；`recruit.db.after-undo` 与 before 哈希一致；
       行数 + 内容 sha256 与 `recruit.db.before` 一致；审计新增 `undo_of` 行（撤销本身是新写入）。
9. [x] 冲突用例：第二次写库后 out-of-band 改 1 行 `event_projects.title`（不产生审计）；
       任务级撤销 → 该行 `skip`、其余撤销，任务卡显示「已撤销 N-1 / 冲突 1」；截图 `ui-force-confirm.png`。
10. [x] 强制撤销 → 写回 `old_values`，`result=forced`；审计同时有 1 skip + 1 forced；已重新导出审计。
11. [x] 任务卡、审阅层 diff、强制撤销二次确认已截图；来源卡「最近手动读取」与撤销结果 chip 未单独截图（已知缺口）。
12. [ ] 复核调用记录在合成助手消息 `calls` 中；任务卡截图未展开调用表，未单独取证（已知缺口）。

## 4. 证据清单（owner 填写）

填写后把本表复制到 `manifest.json` 的 `evidence` 字段并运行 §6 校验。`sha256` 一律 64 位小写 hex。

| 证据 | 默认存放位置 | live 实际路径 | sha256 |
| --- | --- | --- | --- |
| 抽取 JSON | `evidence/extraction.json` | evidence/extraction.json | 9024ec7dc4e183c64e9645640b59f890f185e0d676efd5880ed971a39acd1296 |
| 复核输出 | `evidence/review.json` | evidence/review.json | 1c376ecdd5542a550c66e27b300ad4cabde3eb7e14b0bfe5956eb35fd18c769e |
| 审计导出 | `evidence/audit-export.json` | evidence/audit-export.json | e3dafa7d6edded6b7e82f6a1d22a0b6ddec0d9c20414c0838f7ae665ba05ba83 |
| 任务日志 | `evidence/task.json` | evidence/task.json | b7e37941ae6a1a6793717c24e21818937b04af9879524e5b41f696c5a43343e9 |
| 截图 1 列表页 | 本机 `.../evidence/01-list.png` | C:\Users\cccHaozz\Documents\career-agent-acceptance\24-swufe\01-list.png | 9cbd3315508fa9c772a0ded8c1a8fef7e09201c32f9ac5777122b80980388c65 |
| 截图 2 活动详情 | 本机 `.../evidence/02-detail.png` | C:\Users\cccHaozz\Documents\career-agent-acceptance\24-swufe\02-detail.png | 9753c62bea3a36d4daad7b3c70413d24831ef8a6502a92cfe940a566bc626fa3 |
| 任务卡截图 | `evidence/ui-task-card.png` | evidence/ui-task-card.png | 96231ccfeb5406e72acc750f2033c33f213a70fd0139e57c3971e95cb75bdfa0 |
| 审阅层截图 | `evidence/ui-audit-review.png` | evidence/ui-audit-review.png | db3cd5c3e530a002c1db7f801d6f793b1e98a37db7b0a28c8ddf6c4c05142c3b |
| 强制撤销确认截图 | `evidence/ui-force-confirm.png` | evidence/ui-force-confirm.png | 68f8584a981928e4f2aa6c34e074e2c8c0892aa85d091b605cd721670d8bac71 |
| DB 验收前 | `evidence/recruit.db.before` | evidence/recruit.db.before | 2bb911bf465c5fa1bacb8a0edd5a5d2f561c7dd5da38ec14b574701263bfa05a |
| DB 写库后 | `evidence/recruit.db.after` | evidence/recruit.db.after | 03a84ec5d49bca39d9914a0d98ecf5d7b03122e2771bbed142ee70440d3bf5eb |
| DB 撤销后 | `evidence/recruit.db.after-undo` | evidence/recruit.db.after-undo | 65e26166571b28740d80da622ec0bf971de879978d8403e7f1135fd364639e38 |

## 5. 哈希与 DB 快照命令

### 5.1 停写后复制 DB（Windows PowerShell）

```powershell
New-Item -ItemType Directory -Force docs/acceptance/24-swufe/evidence | Out-Null
# 1) WAL checkpoint，确保主库文件包含全部已提交数据
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();" "<CAREER_DATA_DIR>/users/<userId>/.data/recruit.db"

# 2) 复制快照到证据目录（before / after / after-undo 各做一次）
Copy-Item "<CAREER_DATA_DIR>/users/<userId>/.data/recruit.db" "docs/acceptance/24-swufe/evidence/recruit.db.before"
```

> 三个快照必须来自同一账号、同一 `recruit.db`；不要用运行中的库直接复制（先 checkpoint）。

### 5.2 计算 events + event_projects 内容哈希（与撤销判定同口径）

```powershell
node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db "docs/acceptance/24-swufe/evidence/recruit.db.before"
node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db "docs/acceptance/24-swufe/evidence/recruit.db.after"
node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db "docs/acceptance/24-swufe/evidence/recruit.db.after-undo"
```

输出 `{"events":N,"projects":M,"hash":"..."}`：把 `hash` 填进 `contentHash`，`events` / `projects` 填进对应字段。
干净撤销通过的硬条件：`before.hash === after-undo.hash` 且行数一致。

### 5.3 计算文件 sha256

```powershell
Get-FileHash -Algorithm SHA256 "<文件>" | Select-Object -ExpandProperty Hash
# 或：sha256sum "<文件>"
```

### 5.4 导出审计与复制任务日志

- 在审阅层顶部工具栏点「导出 JSON」（或 `GET /api/audit/export?format=json&taskId=<taskId>`），保存为 `evidence/audit-export.json`。
- 复制任务日志：`<CAREER_DATA_DIR>/users/<userId>/tasks/<taskId>.json` → `evidence/task.json`。
- 任务日志里若含本机绝对路径或截图文件名，属于任务证据引用，不是联系方式；不要改内容，只记录哈希。

## 6. 填写 manifest 并校验

```powershell
Copy-Item docs/acceptance/24-swufe/manifest.template.json docs/acceptance/24-swufe/manifest.json
# 按 §4/§5 填完后：
node docs/acceptance/24-swufe/verify-evidence.mjs docs/acceptance/24-swufe/manifest.json
```

校验器会逐项检查：`status=passed`、签字结论/日期/姓名、无占位符、每个证据文件存在且 sha256 一致、
抽取/复核/审计 JSON 不含联系方式、DB 内容哈希与行数一致、撤销前后快照一致、`browserReads=2`、
`collectorRuns=0`、`fetchTextCalls=0`、`contactFields=0`、`auditDataRatio='1:1'`、
`conflictSkipped>=1`、`forced>=1`、`companyDbCreated=false`、`duplicateRows=0`、`durationMs<=15 分钟`、
`agentLeg.passed=true`。任一不满足即退出码非 0，不得签字。

## 7. 成功 / 失败判定（摘自 docs/plan/24 §9–§10）

| 维度 | 通过条件 | 失败即判定 |
| --- | --- | --- |
| 入口 | 来源卡可发起；回对话并打开抽屉；源卡仍 disabled + 最近手动读取 | 改「已接入」或写采集器 last_run |
| 边界 | 浏览器 2 次；采集器 / fetchText 对 swufe 0 次；无 stealth；无登录/验证绕过 | 采集器被调用、直连抓取、翻页/批量 |
| 抽取 | 清晰活动 100%；单位 ≥90%；单位名逐字正确；零编造；联系方式 0 | 编造、漏活动、重复、联系方式入库/入审计 |
| 本次已知偏差 | 2 个单位名 / 3 个标题·场地字段疑似截断；非匹配活动 sourceUrl 留空；调用记录无 tokens/¥；来源卡/撤销 chip/调用表未单独截图 | 作为「验收通过（含已知偏差）」记录，不静默改数据 |
| 写库 | 只写 events/event_projects；source_id=manual；source_url 记录；company.db 0 写 | 写公司档案、未审计写入 |
| 审计 | 数据行与审计 1:1；old/new 完整；fail closed；source_ref 指截图 | 不 1:1、old/new 缺失 |
| 复核 | 真实 Agent 成功 1 次；建议制未改写入集；问题存证据 | Agent 未成功、复核改了写入集 |
| 撤销 | 干净撤销前后一致；冲突 1 skip + 强制 forced；计数与审计一致 | 快照不一致、无 skip/forced |
| 时间/成本 | 整任务 ≤15 分钟；调用记录有 tokens 与约 ¥ | 超时、无调用记录 |
| 证据/签字 | 本页填完 + `manifest.json` 校验通过 + owner 签「验收通过 + 日期」 | 缺证据、伪造、未签字 |

## 8. 签字区（owner 在 live 通过后填写）

- 结论：验收通过（含已知偏差）
- 日期：2026-10-26
- 验收人：owner
- 证据清单：manifest.json sha256 76b876145ce8593360e98f12af482c4861167b5af0e31f20187531c5c834f2da
- 备注：live 首验按本 README 执行；确定性回归 334 项通过；证据包校验通过。已知偏差：复用本机已有 DeepSeek Key（MODEL_VAULT_DIR 显式传入，运行后删除副本）；复核 Agent 是 claude -p --tools "" 的本地 MCP 桥，不是 claude mcp serve；列表页 3 场活动均写入；只打开 1 场详情；2 个单位名被页面截断；review 已标 high，未编造；冲突用例为 out-of-band 改 1 行（不触发写网关/审计），不是界面修改；review 返回 7 个问题（2 high、3 medium、2 low：截断单位名/标题/场地、非匹配活动 sourceUrl 留空）；建议制，不修改写入集；复核调用记录只有 step/duration；桥不返回 usage，未显示 tokens/约 ¥；来源卡「最近手动读取」、撤销结果 chip、调用表未单独 live 截图；原始页面截图含联系方式，已备份到本机 SCREENSHOT_BACKUP_DIR（不入库）。

> 签字前必须已运行 §6 校验并通过。**不得**在未执行 live、或校验未通过时填写「验收通过」。

## 9. 确定性回归复跑

```powershell
node --test tests/acceptance-swufe.test.mjs
npm test
```

该回归使用临时数据目录、固定 fixture（联系方式已剔除）与本地假 MCP Agent，覆盖写库、审计 1:1、幂等重放、
任务级撤销、冲突 skip + 强制 forced，并断言 `company.db` 未创建、采集器/fetchText 0 次、无重复行。
它不替代本页的 live 证据。
