# 变更记录（CHANGELOG）

> 每个阶段一行，方便你对照"什么时候改了什么、能不能回退"。
> 回退：`git checkout <tag>` 或 `git reset --hard <tag>`（数据在 `%LOCALAPPDATA%\ZhiXiang`，不受影响）。

## v3.0.0-m2m4 · 2026-10-24

**M2 + M4：采集框架拆分 + 活动生命周期**

- 采集源拆成 `src/recruit/sources/` 一校一文件，自动发现；新增学校只加一个文件
- 13 个源（5 个已接入），源卡片显示最近采集时间、状态、条数、失败原因
- 采集并发 2（SQLite busy_timeout 5s），保留同域限速
- 活动生命周期：`active / cancelled / possibly_removed`；连续 3 次缺失标记"可能撤下"，再次出现恢复
- 截断保护：列表被 limit 截断时不做缺失标记，避免误伤
- 多源合并：`cross_sources` + 置信度提升；多源活动不参与单源缺失标记
- 旧数据库自动迁移（ALTER TABLE 加列，不回写历史）
- 界面新增「可能撤下 / 已取消 / 多源收录」标签
- 新增 `tests/sources.test.mjs`（4 项）、`tests/lifecycle.test.mjs`（6 项），共 68 项测试
- 验证：82 场活动迁移后全部 active；实采 2 个源正常；页面 13 张源卡片、无报错
- 回退：`git reset --hard v3.0.0-m7`

## v3.0.0-m7 · 2026-10-24

**M7：四个技能包 + 技能路由**

- 新增 `src/skills/{schedule-planner,company-research,resume-tailoring,interview-prep}/`
- 每个技能含 `SKILL.md`（元信息/步骤/边界）、`prompt.md`（模型约束）、`checklist.md`（验收）
- 新增 `loadSkill` 与 `selectSkill`：按最长触发词确定性选择，聊天状态显示「使用技能：xxx」
- 技能限定工具白名单：模型只能看到该技能允许的工具
- 技能说明进入系统提示词；任务记录写入 `skill` 字段
- 新增 `tests/skills.test.mjs`（6 项：清单、加载、路由、提示词、工具限定、完整链路）
- 验证：58 项测试通过；实测「这周成都有什么宣讲会」→ 行程规划；面板显示 6 工具 / 4 技能
- 回退：`git reset --hard v3.0.0-m8`

## v3.0.0-m8 · 2026-10-24

**M8：三层记忆 + 记忆面板**

- 长期画像：`memory/profile.json`，支持增删改查、同 key 更新、最多 50 条
- 任务记录：`memory/tasks.json`，自动记录计划/工具/产出/耗时，保留最近 100 条
- 画像注入系统提示词：`buildPrompt` → `context.profile`，下一轮对话直接生效
- 接口：`GET /api/memory`、`POST /api/memory/profile|profile/import|profile/delete|profile/clear|tasks/clear`
- 左侧「记忆与画像」面板：查看会话记忆、手动添加/导入/删除画像、查看任务、清空
- 新增 `tests/memory.test.mjs`（7 项：校验、上限、去重、导入、任务、上下文）
- 验证：52 项测试通过；接口实测增删查；画像正确进入提示词；面板无报错
- 回退：`git reset --hard v3.0.0-m6`

## v3.0.0-m6 · 2026-10-24

**M6：统一工具注册表 + 能力面板**

- 新增 `src/tools/registry.mjs`：6 个工具的唯一定义来源（schema / 权限 / 超时 / handler）
- 新增 `src/tools/policy.mjs`：参数校验从 schema 推导，不再维护第二份字段表
- 新增 `src/tools/execute.mjs`：去重、权限、超时、错误归一
- 新增 `src/tools/handlers/*`：招聘查询、搜索、公司调研、平台工具的实现迁出模型层
- 删除 `tool-policy.mjs`（三处重复之一），`platform-mcp.mjs` 改为从注册表生成
- 新增 `GET /api/capabilities` 与左侧「⚙ 能力与记忆」面板
- 新增 `npm run tools` 命令行清单
- 新增 `tests/tools.test.mjs`（注册表一致性、校验、执行器、技能扫描）
- 验证：45 项测试通过；能力面板显示 6 工具 / 3 层记忆；聊天链路（模拟接口）正常
- 回退：`git reset --hard v3.0.0-phase0`

## v3.0.0-phase0 · 2026-10-24

**Phase 0：整理与地基**

- 代码按层重组：`src/{server,agent,model,platform,tools,recruit,web,schemas,config}`、`scripts/`、`tests/`
- 运行时数据外置到 `%LOCALAPPDATA%\ZhiXiang`；首次启动自动迁移旧 `.data`（保留旧目录，不删除）
- 新增 `scripts/check.mjs`（环境/数据/数据库/测试一键自检）
- 新增 `tests/paths.test.mjs`（数据目录解析与迁移）
- 文档归档：`docs/archive/v2/`、`docs/assets/`、`docs/examples/`
- 启动脚本、package scripts、首次登录提示同步更新
- 验证：37 项测试通过；服务从新入口启动；79 场活动、登录、页面、导出均正常
- 项目体积：105 MB → 约 2 MB（不含 node_modules）

## v2.0.0 · 2026-10-23

**v2 baseline（重构前快照）**

- 账号隔离、模型预设、Key 加密、七阶段体检、流式与重试
- 高校招聘采集（5 个可用源）、SQLite、行程/ICS 导出
- 招聘日历页面、局域网模式
- 32 项测试

---

## 分支与标签约定

| 标签 | 含义 |
| --- | --- |
| `v2.0.0` | 重构前可用版本 |
| `v3.0.0-phase0` | 目录重组 + 数据外置完成 |
| `v3.0.0-m6` | 工具注册表 + 能力面板 |
| `v3.0.0-m8` | 三层记忆 |
| `v3.0.0-m7` | 技能包 |

分支：`main`（稳定）、`dev`（集成）、`feat/*`（单个模块）。
