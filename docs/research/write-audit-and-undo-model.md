# 自动写入的审计与批量撤销模型

> Wayfinder 研究票 [#15](https://github.com/Lumichelka/career-agent/issues/15)，父地图 [#12](https://github.com/Lumichelka/career-agent/issues/12)。
> 调研时间：2026-10-25。只查一手来源（IETF/RFC Editor、OWASP、SQLite、MCP），只记决策事实，不写实现、不动代码与 issue。
> 仓库现状：本地 Node Web + SQLite，单服务多登录用户、按用户数据目录隔离；写工具有 `resume.save_version`、`application.upsert`、`memory.write`、`recruit.refresh`（[01-v3重构方案](../plan/01-v3重构方案.md) §6.2）。

## 0. 结论速览

- **幂等键是"资源所有者自定义"的机制，不是协议强制项。** IETF 现行草案 `-08`（2026-10-22）只规定"键唯一、不得与不同载荷复用、重复请求怎么回"，**键的作用域、格式、TTL 全部由各自 API 自己定义并公布**（[草案 §2.2–2.3](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。本仓库必须自己定这三件事。
- **键的作用域应是"用户 × 操作 × 键值"的复合键，不是全局唯一键。** 草案安全章节明确建议用"客户端键 + 只有资源知道的客户端属性"做缓存查找键，否则低熵键会跨客户端泄露别人的已存响应（[草案 §5](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **重复请求的三种情况有明确分工**：原请求仍在处理中 → `409`；同键不同载荷 → `422`；缺键 → `400`；已完成后重试 → 返回"与请求已按用户意图完成相一致"的响应（草案用 SHOULD，且**没要求逐字节重放已存响应**）（[草案 §2.6–2.7](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **MCP 不提供幂等兜底。** 2026-07-28 取消断流续传：流一断请求即丢失，客户端 **MUST** 用**新** request id 重新发起；协议层没有幂等键或去重字段（[changelog 第 9 条](https://modelcontextprotocol.io/specification/2026-07-28/changelog)）。
- **审计必须存"操作 + 旧值 + 新值"，只存最终快照不够。** JSON Patch 的 `remove` 不携带被删值，JSON Merge Patch 用 `null` 表示删除且不区分"设为 null"与"删除"——两者单独都无法把状态还原回去（[RFC 6902 §4.2](https://www.rfc-editor.org/rfc/rfc6902.html)、[RFC 7386 §1](https://www.rfc-editor.org/rfc/rfc7386.html)）。
- **单库批量撤销可以做到"要么全撤要么全留"。** SQLite 的单事务提交在断电/崩溃下也是原子的，`SAVEPOINT` 可嵌套并在事务内回滚到指定点（[Atomic Commit §1](https://sqlite.org/atomiccommit.html)、[Savepoints §2](https://sqlite.org/lang_savepoint.html)）。
- **补偿操作（compensating action）在单库本地应用里不是规范要求。** 它是"跨服务、不能用本地 ACID 事务"的产物；本仓库的回滚用事务即可，DB 之外的效果（本地文件、外部 API）才需要补偿，那属产品取舍（[Saga 模式](https://microservices.io/patterns/data/saga.html)）。
- **UUIDv7 适合作时间有序的审计事件 id**（RFC 明确 SHOULD 优先于 v1/v6，可按字节排序、索引局部性好），但它不保证严格递增（同毫秒要靠计数器），且**不得当权限凭证**、会泄露创建顺序（[RFC 9562 §5.7、§6.11、§8](https://www.rfc-editor.org/rfc/rfc9562.html)）。

## 1. 写操作的幂等键：IETF 草案与 MCP

### 1.1 版本与状态（先确认没引到过时文本）

| 项 | 事实 |
| --- | --- |
| 现行版本 | `draft-ietf-httpapi-idempotency-key-header-08`，2026-10-22 发布，2027-04-25 过期（[datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)） |
| 状态 | Active Internet-Draft、httpapi WG 文档、**Intended RFC status: (None)** ——即**还不是 RFC**，不能当标准引用（同上） |
| 取代关系 | 取代更早的 `draft-idempotency-header`（同上） |
| 变更点 | `-08` 只做引用更新（RFC 9110/9457/9562/9651）、删无用 ABNF、**并入 #48 的 Retry 文本（"仍开放讨论"）**、加作者（[草案 Appendix A](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)） |

### 1.2 草案的语义（区分强制/建议）

- **键的语法**：`Idempotency-Key` 是 Item Structured Header，值 **MUST** 是 String（[§2.1](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **唯一性/作用域**：键 **MUST** 唯一、**MUST NOT** 与不同载荷复用；唯一性**由资源所有者定义、由客户端实现**；推荐用 UUID（[§2.2](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **指纹（fingerprint）**：**MAY**；由资源**从请求载荷生成**；可选算法：整包校验和、选中字段校验和、逐字段比对、请求签名（[§2.4](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **重复请求**：首次→正常处理；**已完成后的重试**→SHOULD 返回与"请求已按用户意图完成"一致的响应；**原请求未完成时的并发重试**→SHOULD 返回资源冲突错误（[§2.6](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **错误码**：缺键→**400**（带 problem+json 或 `Link` 说明）；同键不同载荷→**422**；处理中重复→**409**（[§2.7](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **TTL/清理**：资源 **MAY** 要求带时间信息的键以便过期清理；资源 **SHOULD** 定义过期策略并写进文档。**草案没有给任何具体 TTL 数值**（[§2.3](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **安全**：要固定键格式并校验；缓存查找用**复合键**（客户端键 + 仅资源知道的属性）；否则低熵键可被枚举，用来读取别人的幂等缓存（[§5](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。
- **客户端诚实边界**：客户端可以带键表达"只想执行一次"，但**没有先验知识时不能假定服务端会尊重它**（[§2.5.1](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。

### 1.3 MCP 2026-07-28：没有幂等要求，只有"用新 id 重发"

- **无续传**：`Last-Event-ID` 与 SSE 事件 id 已从 Streamable HTTP 移除；响应流一断，进行中的请求即丢失，客户端 **MUST** 以**新的 request id** 重新发起（[changelog 第 9 条](https://modelcontextprotocol.io/specification/2026-07-28/changelog)）。
- **重试也换 id**：`input_required` 之后带 `inputResponses` 重试原请求时，JSON-RPC `id` **MUST** 与初始请求不同（[Tools · Input Required](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。
- **没有幂等/去重机制**：工具层与 schema 里都没有幂等键、请求指纹或"服务端必须去重"的条款；工具 `annotations` 只是"描述工具行为"的可选属性，而且客户端 **MUST** 视为不可信，除非服务端本身可信（[Tools · Tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。
- **结论**：MCP 场景的"重试不重复写入"必须由本仓库的写入层自己做，不能指望协议或客户端。这与此前 [#19 研究](mcp-client-orchestration.md) 的风险项一致。

## 2. 旧值/新值的表示：JSON Patch、Merge Patch 与 UUIDv7

### 2.1 两个补丁格式的差别

| 维度 | RFC 6902 JSON Patch | RFC 7386 JSON Merge Patch |
| --- | --- | --- |
| 表达方式 | 操作数组（`add`/`remove`/`replace`/`move`/`copy`/`test`），按顺序作用（[§3](https://www.rfc-editor.org/rfc/rfc6902.html)） | 形似目标文档的片段；对象递归合并，`null` 表示删除（[§1](https://www.rfc-editor.org/rfc/rfc7386.html)） |
| 删除能否带旧值 | **不能**：`remove` 只给 `path`（[§4.2](https://www.rfc-editor.org/rfc/rfc6902.html)） | **不能**：只能表达"删掉"，旧值不在补丁里 |
| 并发校验 | 有 `test` 操作，可做乐观校验（[§4.6](https://www.rfc-editor.org/rfc/rfc6902.html)） | 没有前置条件语义，靠 HTTP 层 |
| 适用 | 需要精确、可审计的字段级改动 | 以对象为主、不用显式 `null` 的粗粒度配置（[§1](https://www.rfc-editor.org/rfc/rfc7386.html)） |
| 失败语义 | 任一操作失败则 SHOULD 终止，整个补丁 **SHALL NOT** 视为成功（[§5](https://www.rfc-editor.org/rfc/rfc6902.html)） | 由服务器决定具体操作，规范把"是否合适/是否有权"留给实现（[§5](https://www.rfc-editor.org/rfc/rfc7386.html)） |

### 2.2 为什么审计要"操作 + 旧值 + 新值"而不是只存快照

- **补丁本身不可逆**：`remove` 不携带被删内容，`null` 在 Merge Patch 里既表示"删除"又无法表达"把值设为 null"，所以**没有旧值就无法反向应用**（[RFC 6902 §4.2](https://www.rfc-editor.org/rfc/rfc6902.html)、[RFC 7386 §1](https://www.rfc-editor.org/rfc/rfc7386.html)）。
- **Merge Patch 的"新值"甚至不是客户端给的**：具体要改哪些字段由服务端比对当前内容得出（[RFC 7386 §2](https://www.rfc-editor.org/rfc/rfc7386.html)）——不记录服务端实际执行的操作，事后无法解释"这条记录为什么变成这样"。
- **审计的最小可解释单元是"动作 + 对象 + 结果"**，不是最终状态：OWASP 把 `Action`（原意）、`Object`（受影响对象）、`Result status`、`Reason` 列为建议记录的属性（[Logging · Event attributes](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-attributes)）。
- **推论（非规范）**：`旧值 + 新值` 同时给了"可反向应用"和"可展示 diff"两种能力；只存快照则两者都做不到。撤销时先做 `test`（旧值仍等于记录值）再反向写，才能避免覆盖别人的新改动——这是把 RFC 6902 `test`（[§4.6](https://www.rfc-editor.org/rfc/rfc6902.html)）用在审计上的产品设计，规范没有规定。

### 2.3 UUIDv7 适合作审计事件 id 吗

- **结构**：高 48 位是 Unix 毫秒时间戳，其余 74 位随机；可选亚毫秒时间片或计数器补单调性（[§5.7](https://www.rfc-editor.org/rfc/rfc9562.html)）。RFC 9562（2024-05）**已取代** RFC 4122，勿再引旧版 v1/v4 布局。
- **排序/索引**：v6/v7 设计成**不解析就能按原始字节排序**，时间有序带来更好的索引局部性，差异可达一个数量级（[§6.11](https://www.rfc-editor.org/rfc/rfc9562.html)）。
- **官方偏好**：实现 **SHOULD** 优先用 v7 而不是 v1/v6（[§5.7](https://www.rfc-editor.org/rfc/rfc9562.html)）。
- **不是严格顺序**：同毫秒需要计数器/时间片才保证单调，时钟回拨要专门处理（[§6.1](https://www.rfc-editor.org/rfc/rfc9562.html)、[§6.2](https://www.rfc-editor.org/rfc/rfc9562.html)）；要"严格按提交顺序"仍需服务端序列/自增列。
- **安全边界**：UUID **MUST NOT** 当安全能力（持有即授权的凭证）；时间戳会暴露创建先后（"very small attack surface"），安全场景应用 v4（[§8](https://www.rfc-editor.org/rfc/rfc9562.html)）。
- **存储**：数据库里 **SHOULD** 存 128 位二进制而非文本（文本要 288 位）（[§6.13](https://www.rfc-editor.org/rfc/rfc9562.html)）。

## 3. 审计日志最小字段与脱敏

### 3.1 记什么：OWASP 的"when / where / who / what"

- 每条日志必须能回答 **when、where、who、what**；并建议记录 `Interaction identifier`，把一次用户交互产生的多条事件串起来（[Logging · Event attributes](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-attributes)）。
- `who` 用**已认证身份**（如用户表主键），`what` 含事件类型/严重级/描述，另建议 `Action`、`Object`、`Result status`、`Reason`（同上）。OWASP 也提醒"不要记太多，也不要记太少"，用目的驱动字段（[Logging · Purpose](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#purpose)）。
- **落到本仓库的最小集（产品映射，非规范原文）**：`event_id`(UUIDv7) / `occurred_at` / `actor_user_id` / `source`(Web UI、Agent、MCP) / `action`(工具名) / `target`(记录类型+id) / `old_value` / `new_value` / `result` / `reason` / `interaction_id`(一次交互串联) / `idempotency_key`(若走幂等写入)。

### 3.2 不记什么：OWASP 的排除清单

- 通常**不应直接落日志**，而要移除/掩码/散列/加密：应用源码、会话标识值、访问令牌、**敏感个人数据与部分 PII**（健康、政府标识符、弱势人群）、认证口令、数据库连接串、加密密钥等主密钥、银行账户/支付卡数据、高于日志系统密级的数据、商业敏感信息、违法收集的信息、用户已选择退出或未同意的数据（[Logging · Data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)）。
- **非敏感个人数据（姓名、电话、邮箱）也可能要特殊处理**；在不需要识别个人时可做去标识化/伪名化（同上）。
- 记忆类写入前要**审计内容是否含敏感数据**（[AI Agent Security · Memory](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#3-memory-context-security)）。

### 3.3 保留与销毁

- OWASP 要求日志、临时调试日志以及备份/导出**不得在所需数据保留期结束前销毁**（[Logging · Disposal of logs](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#disposal-of-logs)）。**具体保留多久、按什么法规，规范没有给数值。**
- 另有两点与"自动写入"直接相关：日志系统本身要有防篡改与访问记录（[Logging · Protection](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#protection)）；日志失败不能阻断主流程，但**审批/审计失败时应 fail closed**（[AI Agent Security · High-Impact Action Integrity Controls](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#high-impact-action-integrity-controls)）——两条要求方向相反，需要产品决定谁优先。

### 3.4 Human-in-the-loop 与 Excessive Agency

- OWASP LLM Top 10 **2025** 里对应条目是 **LLM06:2025 Excessive Agency**（[条目页](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)）。**抓取限制**：该页与 `genai.owasp.org` 其余页面是客户端渲染，本工具只取到标题，取不到正文；因此下条不引它的原文。
- 可引的 OWASP 原文（AI Agent Security Cheat Sheet）：**高风险或不可逆操作要求显式批准**、执行前给动作预览、按风险分级设自主边界、提供清晰的决策与动作审计轨迹、允许用户中断与回滚（[§4 Human-in-the-Loop](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#4-human-in-the-loop-controls)）。
- 批准的绑定方式也写死了：`user_confirmed` 标志不够，执行组件必须校验**批准属于当前 actor 与这次确切调用**、仍有效、且未被消费，并在执行前**原子地检查并消费**；目标或参数变了要重新批准（[Tool Authorization Middleware](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#tool-authorization-middleware)）。批准记录应含 actor、工具名、目标资源、规范化参数、时间戳、过期时间（同上，High-Impact 节）。
- 两条直接可用的建议：**能幂等的尽量幂等**；不能幂等时要求**显式的重复确认**（同上）。MCP 侧同样要求"始终有人在回路里、能拒绝工具调用"（[Tools · User Interaction Model](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。

## 4. 撤销与批量撤销

### 4.1 SQLite 能给到什么保证

- **原子提交**：单事务内的所有数据库改动**要么全部发生要么全不发生**，即使被系统崩溃或断电打断也成立（[Atomic Commit §1](https://sqlite.org/atomiccommit.html)；该页 2026-04-21 更新）。提交点在 rollback journal 被删除/清空的那一刻（[§3.11](https://sqlite.org/atomiccommit.html)）。
- **事务不嵌套**：`BEGIN...COMMIT` 不能嵌套，嵌套要用 `SAVEPOINT`/`RELEASE`（[Transaction §2](https://sqlite.org/lang_transaction.html)）。
- **SAVEPOINT 语义**：`ROLLBACK TO` 把库恢复到该保存点刚创建后的状态、**不取消事务**而是把事务重新起在该点；`RELEASE` 只从栈上移除保存点，内层"提交"仍可能被外层回滚掉（[Savepoints §2](https://sqlite.org/lang_savepoint.html)）。
- **并发**：多个读事务可并存，**同时只有一个写事务**；升级写失败返回 `SQLITE_BUSY`（[Transaction §2.1](https://sqlite.org/lang_transaction.html)）。
- **两个坑**：`COMMIT` 可能因其他连接的读事务而返回 `SQLITE_BUSY`，此时**事务仍然活着、可以重试提交**（[§2.3](https://sqlite.org/lang_transaction.html)）；`SQLITE_FULL/IOERR/INTERRUPT/NOMEM` 可能只回滚单条语句，也可能回滚整个事务，应用应显式 `ROLLBACK` 让状态确定（[§3](https://sqlite.org/lang_transaction.html)）。

### 4.2 批量撤销落在哪

- "一批写入要么全撤要么全留"在**单库单文件**上由**一个事务**直接支撑，不需要额外的补偿逻辑（[Atomic Commit §1](https://sqlite.org/atomiccommit.html)）；多库/多文件时 SQLite 有 super-journal 机制（[§5](https://sqlite.org/atomiccommit.html)），但本仓库是单库，用不上。
- 需要"部分成功、其余回滚重试"时用 `SAVEPOINT` 逐条设点，失败 `ROLLBACK TO` 该点、继续下一条（[Savepoints §2](https://sqlite.org/lang_savepoint.html)）。注意内层 `RELEASE` 不等于落盘，外层仍可整体回滚（同上）。
- **撤销本身也是一次写入**：它应当走和原写入同一套幂等键与审计字段，否则"撤销"会被重试成"撤两次"——草案的键唯一性约束同样适用（[草案 §2.2](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）。

### 4.3 补偿操作：需要还是不需要

- **Saga 的补偿事务是为跨服务场景发明的**：每个服务各有数据库、业务事务跨服务时无法用本地 ACID，才需要用补偿事务撤销已完成步骤；其明确代价是"没有自动回滚"（[Saga](https://microservices.io/patterns/data/saga.html)，行业模式，非规范）。
- **反推本仓库**：单库本地应用，数据库内的状态有 `ROLLBACK`/`SAVEPOINT` 的自动回滚，**不需要**为"撤销一批写入"再设计一套补偿动作（[Atomic Commit §1](https://sqlite.org/atomiccommit.html)）。
- **DB 之外的效果**（写入用户数据目录的文件、调用外部平台、发通知）不在事务里，SQLite 的原子性覆盖不到；这部分要不要补偿、怎么补偿，**没有一手规范给答案，属产品取舍**（此句为边界说明，不是外部结论）。

## 5. 敏感数据确认（只划边界，不研究成外部结论）

- 外部资料能回答的只有两件事：**哪些字段不该落日志/该最小化**（[Logging · Data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)），以及**写入前要审敏感数据**（[AI Agent Security · Memory](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#3-memory-context-security)）。
- **"简历 / 投递 / 面试 / 画像必须人工确认"是本仓库既有产品规则**，不是外部研究结论：写入要确认、改简历/记投递/改日程先预览再落库（[01-v3重构方案](../plan/01-v3重构方案.md) 原则 5、§6.1），长期记忆只写"用户确认过"的内容（同上 §6.1），对应工具标注为 write 且"需确认"（同上 §6.2）。
- 因此审计模型只需保证：**确认记录可追溯**（谁、何时、对哪次确切调用批准），以及**敏感字段在审计里被脱敏**。前者引 OWASP 的批准绑定要求（[Tool Authorization Middleware](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#tool-authorization-middleware)），后者引脱敏清单（[Data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)）。

## 6. 外部规范没有答案的产品决策

以下问题在 IETF/RFC/OWASP/SQLite/MCP 里**都找不到答案**，只能由本仓库拍板：

1. **撤销粒度**：单条、一次交互（`interaction_id`）、还是一批导入任务？规范只提供"事务/保存点"这种机制，不定义业务粒度。
2. **保留期**：幂等键活多久（草案只说"资源自己定义并公布"，[§2.3](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)）、审计日志留多久（OWASP 只给"不得提前销毁"，[Disposal](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#disposal-of-logs)）。
3. **可见性**：审计给谁看（本人 / 管理员 / 导出给外部 AI）、旧值里的敏感内容要不要对本人也脱敏。
4. **撤销的时效窗口**：多久之内可撤、过期后是"只能补偿"还是"禁止"。
5. **冲突策略**：撤销时旧值已被改，是拒绝、强制覆盖、还是生成反向冲突记录（RFC 6902 只提供 `test` 原语，[§4.6](https://www.rfc-editor.org/rfc/rfc6902.html)）。
6. **DB 外效果的补偿**：文件/外部平台失败后是否要补偿，以及补偿失败如何呈现。
7. **日志故障时的取舍**：审计写失败时阻断写入（fail closed）还是继续（[High-Impact 节](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html#high-impact-action-integrity-controls) vs [Logging · Event collection](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-collection)）。

## 7. 对 #15 号票的含义（候选决策点，不替你做决定）

- **D1 幂等键的作用域与载体**：键放请求头（`Idempotency-Key` 草案语义）还是工具参数；作用域取"用户+操作+键"复合键（草案安全建议），还是全局唯一键。选后者要接受跨用户碰撞与泄露风险。
- **D2 重复请求的响应策略**：完成后重试是**重放已存响应**还是**返回 200 + 当前状态**；草案只要求"与请求已按用户意图完成相一致"（[§2.6](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)），没要求逐字节重放，但选后者要有办法自证"一致"。
- **D3 键的保留期与清理**：没有规范数值；可绑定"审计保留期"或独立短周期（如 24h）。需要明确过期后同键重放会变成新写入。
- **D4 审计记录的形态**：`操作 + 旧值 + 新值`（可逆、可 diff）还是只存最终快照（省空间、不可逆）；若选前者，旧值里哪些字段要脱敏，要跟 §3.2 的排除清单一起定。
- **D5 批量撤销的实现基座**：一个事务 + 全部成功才提交（简单、全有全无），还是逐条 SAVEPOINT（可部分成功、要给用户"部分撤销"的 UI）。注意 `COMMIT` 的 `SQLITE_BUSY` 重试要求。
- **D6 撤销的并发校验**：是否强制"旧值仍匹配才允许撤销"（等价于 RFC 6902 `test`），不匹配时拒绝还是记录冲突并覆盖。
- **D7 审计事件 id**：用 UUIDv7（时间有序、索引友好）还是自增序号（严格顺序）；若用 v7，是否需要额外单调序列来保证"同毫秒内严格有序"，以及是否允许对外暴露（会泄露创建时间）。

## 主要来源

- IETF：`draft-ietf-httpapi-idempotency-key-header-08`（[datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)、[全文](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-08.html)，2026-10-22，仍是 I-D）
- RFC：[6902 JSON Patch](https://www.rfc-editor.org/rfc/rfc6902.html)、[7386 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386.html)、[9562 UUIDs](https://www.rfc-editor.org/rfc/rfc9562.html)
- MCP 2026-07-28：[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)（另见本仓 [#19 笔记](mcp-client-orchestration.md)）
- OWASP：[Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)、[AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)、[LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)（页面为客户端渲染，正文未取到）
- SQLite：[Transaction](https://sqlite.org/lang_transaction.html)（更新 2026-02-18）、[Savepoints](https://sqlite.org/lang_savepoint.html)、[Atomic Commit](https://sqlite.org/atomiccommit.html)（更新 2026-04-21）
- 行业模式（非规范）：[Saga](https://microservices.io/patterns/data/saga.html)（Chris Richardson）
- 仓库内：[01-v3重构方案](../plan/01-v3重构方案.md)（写入需确认、写工具清单）、[mcp-client-orchestration.md](mcp-client-orchestration.md)
