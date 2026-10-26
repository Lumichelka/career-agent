# 24 · 西南财大首个端到端验收证据包（模板）

> 对应 spec [#25](https://github.com/Lumichelka/career-agent/issues/25) / ticket [#42](https://github.com/Lumichelka/career-agent/issues/42)，执行口径见 [docs/plan/24-首个端到端验收规格.md](../../plan/24-首个端到端验收规格.md)。
>
> **当前状态：模板（pending），尚未执行 live。** 本页与 `manifest.template.json` 只定义「要收哪些证据、怎么核」，
> 不含任何真实运行结果；不得把确定性回归测试输出、示例值或占位符当成验收证据，**不得伪造**路径、哈希、截图与签字。

## 0. 模板、确定性回归与 live 的边界

- `tests/acceptance-swufe.test.mjs` 是**确定性回归**：临时数据目录、固定抽取 fixture、本地假浏览器/假视觉/假 MCP Agent，不联网、不调视觉 API。
  它证明代码链路可重复，**不等于** live 验收。
- live 验收必须由 owner 在本机真实执行一次：真实 Edge 浏览器两次读取、真实视觉模型 API 抽取、真实外部 Agent 复核一次成功。
- 只有 live 通过后，owner 才能把 `manifest.json` 的 `status` 改为 `passed`、填签字区并写「验收通过 + 日期」。
- 原始页面截图（`01-list.png` / `02-detail.png`）可能含联系方式：**只记本机路径 + sha256，不复制进仓库**。

## 1. 证据目录约定

```
docs/acceptance/24-swufe/
├── README.md                      # 本模板（owner 完成后在原处填表与签字）
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

- [ ] 使用**空的临时** `CAREER_DATA_DIR`（不碰真实用户数据），并记录绝对路径。
- [ ] `npm start` 正常启动；注册/登录一个独立验收账号，记录 `userId`。
- [ ] 至少配置一个视觉模型 Key（`deepseek-flash` 或 `glm-4.6v-flash`），并在「模型与接口设置」里保存。
- [ ] 配置文本后端（Codex 或模型 API），确保对话与调用记录可用。
- [ ] 配置并启用一个外部 Agent（Claude Code；不可用回退 Coze），「测试连接」通过；记录 Agent 名称与复核工具名。
- [ ] 本机 Microsoft Edge 可用；确认没有 stealth / 反检测参数、没有伪装 UA（代码固定 `channel:'msedge'`，见 `src/source-check/browser.mjs`）。
- [ ] 确认 `swufe` 采集器仍为 `enabled:false`；不运行 `runCollection`，不改采集器配置。
- [ ] 关闭其他任务与自动写入，避免并发；整任务限时 15 分钟。
- [ ] 记录 `git rev-parse HEAD`、`node -v`、Edge 版本。
- [ ] 记录验收前 `recruit.db` 快照：`recruit.db.before`（见 §5）。

## 3. live 执行步骤（逐条勾选）

1. [ ] 数据页 → 来源 → 西南财大卡片（`disabled`，原因 robots）→「来源校对」；确认提示「采集器禁用，改用浏览器读取」。
2. [ ] 应用内浏览器只打开列表页与一场活动详情各一次，各截图一次；不翻页、不并发、不绕过登录/验证。
       记录两次读取的 URL、页面标题、时间与视口（`screenshots.json`）。
3. [ ] 视觉模型 API 只依据两张截图抽取，产出 `extraction.json`：活动 1 场、单位尽可能全、读不到留空、零编造；
       联系方式 0 条（任务卡标「含联系方式，已跳过」）。
4. [ ] 外部 Agent 只收到抽取 JSON 与来源元数据做文本复核，产出 `review.json`（`{row,field,issue,severity}` 或原始文本）；
       问题只作建议，**写入集未被修改**；若复核不可用，本项记未通过，不得签「验收通过」。
5. [ ] 写库后核对：只写 `events` / `event_projects`；`source_id='manual'`；`source_url` 只记录；
       `notes` 标「浏览器截图读取（非采集器）」；`company.db` 未创建；无重复活动/单位；联系方式 0 条入库。
6. [ ] 审计核对：数据行与 `write_audit` 1:1；同任务同批次；`actor_type=model_api`；`source_ref` 指向详情截图；
       old/new 整行；导出 `audit-export.json`。
7. [ ] 记录写库后快照 `recruit.db.after`。
8. [ ] 任务级撤销（审阅层「撤销本任务全部自动写入」）：撤销结果「已撤销 N」；记录 `recruit.db.after-undo`；
       行数 + 内容 sha256 与 `recruit.db.before` 一致；审计新增 `undo_of` 行（撤销本身是新写入）。
9. [ ] 冲突用例：再执行一次同来源写库，写后手工改 1 行 `event_projects.title`（界面修改，不产生审计）；
       任务级撤销 → 该行 `skip`、其余撤销，任务卡显示「已撤销 N-1 / 冲突 1」；截图 `ui-force-confirm.png`。
10. [ ] 强制撤销 → 写回 `old_values`，`result=forced`；审计同时有 `skip` 与 `forced`；再导出一次审计（覆盖冲突证据）。
11. [ ] 界面证据：任务卡、审阅层 diff、强制撤销二次确认、撤销结果就地 chip、来源卡「最近手动读取 + 原因」。
12. [ ] 调用记录：助手消息下可展开 `step=review` 的调用表，含 tokens 与「约 ¥」（供应商未回传则显示「未回传」）。

## 4. 证据清单（owner 填写）

填写后把本表复制到 `manifest.json` 的 `evidence` 字段并运行 §6 校验。`sha256` 一律 64 位小写 hex。

| 证据 | 默认存放位置 | live 实际路径 | sha256 |
| --- | --- | --- | --- |
| 抽取 JSON | `evidence/extraction.json` | <待填写> | <待填写> |
| 复核输出 | `evidence/review.json` | <待填写> | <待填写> |
| 审计导出 | `evidence/audit-export.json` | <待填写> | <待填写> |
| 任务日志 | `evidence/task.json` | <待填写> | <待填写> |
| 截图 1 列表页 | 本机 `.../evidence/01-list.png` | <待填写> | <待填写> |
| 截图 2 活动详情 | 本机 `.../evidence/02-detail.png` | <待填写> | <待填写> |
| 任务卡截图 | `evidence/ui-task-card.png` | <待填写> | <待填写> |
| 审阅层截图 | `evidence/ui-audit-review.png` | <待填写> | <待填写> |
| 强制撤销确认截图 | `evidence/ui-force-confirm.png` | <待填写> | <待填写> |
| DB 验收前 | `evidence/recruit.db.before` | <待填写> | <待填写> |
| DB 写库后 | `evidence/recruit.db.after` | <待填写> | <待填写> |
| DB 撤销后 | `evidence/recruit.db.after-undo` | <待填写> | <待填写> |

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
| 写库 | 只写 events/event_projects；source_id=manual；source_url 记录；company.db 0 写 | 写公司档案、未审计写入 |
| 审计 | 数据行与审计 1:1；old/new 完整；fail closed；source_ref 指截图 | 不 1:1、old/new 缺失 |
| 复核 | 真实 Agent 成功 1 次；建议制未改写入集；问题存证据 | Agent 未成功、复核改了写入集 |
| 撤销 | 干净撤销前后一致；冲突 1 skip + 强制 forced；计数与审计一致 | 快照不一致、无 skip/forced |
| 时间/成本 | 整任务 ≤15 分钟；调用记录有 tokens 与约 ¥ | 超时、无调用记录 |
| 证据/签字 | 本页填完 + `manifest.json` 校验通过 + owner 签「验收通过 + 日期」 | 缺证据、伪造、未签字 |

## 8. 签字区（owner 在 live 通过后填写）

- 结论：<待填写；live 全部通过时写「验收通过」，否则写「不通过」并附原因>
- 日期：<待填写：YYYY-MM-DD>
- 验收人：<待填写：姓名 / 账号>
- 证据清单：<待填写：manifest.json 的 sha256 或提交短哈希>
- 备注：<待填写：已知偏差 / 未覆盖项>

> 签字前必须已运行 §6 校验并通过。**不得**在未执行 live、或校验未通过时填写「验收通过」。

## 9. 确定性回归复跑

```powershell
node --test tests/acceptance-swufe.test.mjs
npm test
```

该回归使用临时数据目录、固定 fixture（联系方式已剔除）与本地假 MCP Agent，覆盖写库、审计 1:1、幂等重放、
任务级撤销、冲突 skip + 强制 forced，并断言 `company.db` 未创建、采集器/fetchText 0 次、无重复行。
它不替代本页的 live 证据。
