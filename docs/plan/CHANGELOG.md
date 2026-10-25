# 变更记录（CHANGELOG）

> 每个阶段一行，方便你对照"什么时候改了什么、能不能回退"。
> 回退：`git checkout <tag>` 或 `git reset --hard <tag>`（数据在 `%LOCALAPPDATA%\ZhiXiang`，不受影响）。

## v3.2.2 · 2026-10-25

**手工来源页、会话管理与视觉收拢**

- 来源页 HTML/JSON 粘贴 → 预览 → 确认写入；失败给原因。
- 对话重命名/导出/删除 API + 侧栏操作。
- 移除主界面公司档案入口，`/companies` 302 到对话；精简重复侧栏/公众号入口。
- 修复日历 7 列溢出、来源表宽度、移动端/桌面布局。
- 测试 130 项；回退 `v3.2.1`。

## v3.2.1 · 2026-10-25

**公众号真实抓取与项目上下文**

- 文章抓取：HTTP → 本机 Edge 渲染 → needPaste；不写验证页垃圾。
- 来源页 harvest：发现 mp.weixin 链接，实测 SYSU 2 篇入库；采集器自动扫描来源页。
- 收紧文章项目抽取：月历/邀请函/标题不再产生假项目。
- 项目详情 API + `/chat?project=` 上下文显示公司/活动；项目“研究 ↗”。
- 测试 129 项。
- 回退：`git reset --hard v3.2.0`

## v3.2.0 · 2026-10-25

**双选会项目主线、公众号并入来源、对话优先**

- 采集器新增项目阶段：源声明 capabilities/fetchProjects，活动入库后自动同步单位项目。
- SWPU 双选会：`getjobfairs` + `list_jobfair_company`；实测 5 场 → 500 单位。
- SCU 双选会：详情 483 不影响 `getjobfaircorporationlistdata` POST；单场 15 单位。
- UESTC：用 Nuxt `onSiteCalendar` API 替换浏览器空壳，实测 5 场。
- 逐源状态矩阵写入 `docs/10`；UIBE/CUFE/SWJTU 等无项目源标注原因/替代。
- 公众号并入来源：9 账号、文章分析、`/wechat` 302、数据页导入/确认。
- 新工具 `career_recruit_projects/project/source_health`；平台只做研究，不登记/投递。
- UI：`/` 对话优先、数据页日历/来源 tab、紧凑来源表、会话搜索、上下文抽屉、移动抽屉。
- 测试 125 项；文档改写 01/00/06/10/15/18/19/20，不新增 plan 21。
- 回退：`git reset --hard v3.1.2`

## v3.1.2 · 2026-10-25

**批量粘贴招聘项目**

- 活动卡片新增「批量粘贴」：每行 `单位 | 岗位 | 要求 | 投递方式 | 链接`
- 一次最多 100 行，自动跳过空行
- 新增 1 项测试，共 110 项
- 回退：`git reset --hard v3.1.1`

## v3.1.1 · 2026-10-25

**平台元素点击与连通性检查**

- 新增「打开第一条结果」：点击当前搜索结果第一条详情，失败转截图 OCR
- 新增「检查 7 站连通性」：HTTP 探测首页并展示状态
- XHS 实测：点击被登录层遮挡时自动转 OCR（241 字）
- 7 站首页探测 7/7 返回 200
- 回退：`git reset --hard v3.1.0`

## v3.1.0 · 2026-10-25

**登录型网站、公众号、日历看板与一对多项目**

- 平台从 2 个扩展到 7 个：BOSS/小红书/实习僧/牛客/智联/51job/猎聘，统一侧栏入口
- 修复 BOSS 打开后跳 about:blank：优先本站页面、关闭 Edge 首次提示、导航 watchdog
- 新增截图 OCR 兜底（Windows OCR）与系统浏览器打开
- 新增公众号账号/文章库（9 个种子账号）、链接/正文导入、文章关联活动
- 新增 `event_projects` 表：一场活动多个招聘项目，项目可增删
- `/recruit` 改为月历看板；工作台统计改为“活动/项目”，移除冲突/通勤
- 删除 `schedule-planner` 技能（4→3）；工具改为按日历列活动+项目
- 新增 `platform/projects/wechat` 测试，共 109 项
- 回退：`git reset --hard v3.0.2`

## v3.0.2 · 2026-10-24

**刷新工作台截图**

- 新增西南石油大学源后，工作台显示 141 场 / 92 场未来 7 天，截图同步
- 无代码变更

## v3.0.1 · 2026-10-24

**新增西南石油大学信息源**

- 新增 `src/recruit/sources/swpu.mjs`：云研列表接口，含起止时间/校区教室/行业/规模
- 采集器支持 `acceptCode`（该接口用 `code=1` 表示成功）
- 实采 20 场，详情页可打开；数据从 121 场增至 **141 场（115 场未来）**，覆盖 7 校
- 源测试更新为 14 个登记源 / 8 个已接入
- 回退：`git reset --hard v3.0.0`

## v3.0.0 · 2026-10-24

**最终验收：文件地图 v3 + 交付清单**

- 重写 `00-文件地图.md`：80 个源码文件、依赖关系、数据目录、常见修改入口、v2→v3 对照
- 新增 `18-最终交付清单.md`：交付物、验收证据、版本标签、交作业检查清单
- 清理过时数字（工具数、测试数、源数）
- 全量验收：98 项测试、71 个文档链接、5 个页面无 JS 报错
- 版本：`v3.0.0`

## v3.0.0-m16 · 2026-10-24

**3.1 收尾：简历 Word 导出**

- 新增 `src/resume/docx.mjs`：零依赖 ZIP + WordprocessingML 生成 DOCX
- 标题/二级标题/列表/普通段落转 Word 样式，XML 转义与中文正常
- 新增 `GET /api/resumes/version/<id>/docx`；简历版本卡加「下载 Word」
- 下载文件名自动去掉非法字符
- 新增 `tests/docx.test.mjs`（4 项），共 98 项测试
- 实测：python-docx 能打开，标题识别 Heading 1，列表保留；浏览器下载成功
- 回退：`git reset --hard v3.0.0-m15`

## v3.0.0-m15 · 2026-10-24

**2.2 公司档案**

- 新增 `src/company/store.mjs`（company.db）：介绍/前景/评价/待遇/文化/来源
- 新增 `/companies` 页面：列表、编辑、来源链接、关联活动/投递
- 对话文稿可「保存为公司档案」；标题去掉“公司调研”前缀作为公司名
- 日历里点公司名跳到档案；没有就预填新建
- 新增只读工具 `company_list` / `company_read`（能力面板 12 工具）
- 同名保存合并；局部更新保留原值
- 新增 `tests/company.test.mjs`（4 项），共 94 项测试
- 回退：`git reset --hard v3.0.0-m14`

## v3.0.0-m14 · 2026-10-24

**1.2.1 + 1.4.1：公众号/手动导入 + 就业指导类型**

- 新增 `manual.mjs`：解析公众号 HTML/粘贴正文 → 标题/日期/时间/地点/单位/类型/投递方式
- 新增 `/recruit` 的「公众号 / 手动导入」对话框：解析预览 → 改字段 → 确认保存
- 类型新增「就业指导」，覆盖讲座/培训/简历门诊/生涯规划（1.4.1）
- 用户主动提供链接才抓，单篇、不批量、不保存全文；失败提示改粘贴正文
- 保存后 sourceId=manual、置信度 0.7，自动提取面试环节/类型
- 新增 `tests/manual.test.mjs`（6 项），共 90 项测试
- 浏览器实测：粘贴正文 → 解析 → 保存 → 行程出现活动，无 JS 报错
- 回退：`git reset --hard v3.0.0-m13`

## v3.0.0-m13 · 2026-10-24

**2.1 字段补全：招聘环节 / 面试类型**

- events 新增 `interview_stage` / `interview_type`，旧库自动加列
- 新增 `extractInterview`：从标题/备注/详情识别无领导、半结构、结构化、群面、单面、笔试
- 识别不到就留空，界面不显示、导出不编造
- 卡片标签、ICS DESCRIPTION、CSV（新增两列）、Markdown 表都带上
- 多源合并时保留已有环节/类型，不用空值覆盖
- 实测：川农 2 场标题含面试信息的活动被正确标注
- 新增 2 项测试，共 84 项
- 回退：`git reset --hard v3.0.0-m12`

## v3.0.0-m12 · 2026-10-24

**M12 第一版：多端、Docker 与备份**

- 新增 `scripts/backup.mjs`：整目录备份、清单、保留最近 N 份、目录保护
- 新增 `Dockerfile` / `docker-compose.yml` / `.dockerignore`（数据卷 `/data`）
- 新增 `backup` npm script；`.gitignore` 排除 `backups/`、`data-docker/`、`dist/`
- 新增部署文档 `14-部署与备份.md`：同 Wi-Fi / Tailscale / Docker / 恢复 / 安全
- 新增 `tests/backup.test.mjs`（2 项），共 82 项测试
- 新增 `15-需求对照与演示.md`：逐条需求、证据、5 分钟答辩脚本
- 实测备份：1062 个文件 / 104.4 MB，清单写入成功
- 说明：本机无 Docker，镜像未实测；成都理工（WAF 412）与电子科大（需登录接口）暂不接入
- 回退：`git reset --hard v3.0.0-m11b`

## v3.0.0-m11b · 2026-10-24

**M11 下半：面试准备落库**

- `interview_preps` 表：公司/岗位/JD/正文/题库（题目、类型、要点、我的回答）
- `/resume` 新增「面试准备」tab：新建、逐题填写回答、保存、删除
- 对话文稿可「保存为面试准备」，跳转 `/resume#interviews`
- 新增只读工具 `interview_list` / `interview_read`（能力面板 10 工具）
- 新增 3 项测试（面试创建/更新/校验/删除、API、工具），共 80 项
- 验证：3 道题填写后刷新仍在；从对话保存后列表 2 条；页面无报错
- 回退：`git reset --hard v3.0.0-m11`

## v3.0.0-m11 · 2026-10-24

**M11 第一版：简历版本库 + 投递跟进**

- 新增 `src/resume/store.mjs`（resume.db）：简历、多版本、JD、投递记录
- 新增 `/resume` 页面：简历库（新建/加版本/查看/下载 .md）与投递看板（阶段/截止/跟进/CSV）
- 对话文稿一键保存：`POST /api/resumes/from-session` + 聊天里的「保存为简历」
- 新增只读工具 `resume_list` / `resume_read`（能力面板 8 工具）
- 提示词要求：改简历前先读原文，不得编造经历/数字
- 工作台/对话/日历导航加入「简历与投递」
- 新增 `tests/resume.test.mjs`（7 项），共 77 项测试
- 验证：创建 → 加版本 → 预览 → 投递 → 改阶段 → CSV；对话保存实测跳转成功
- 回退：`git reset --hard v3.0.0-m5`

## v3.0.0-m5 · 2026-10-24

**M5：地图行程 + 新增两所高校源**

- 每场活动生成高德 URI 地图链接（无需 Key），工作台/日历可点
- ICS 的 DESCRIPTION、CSV（新增「地图链接」列）、Markdown 地点均带地图
- 新增四川农业大学 JSON 源（含校区/教室/起止时间）
- 新增西南交通大学日历 JSON 源（一次返回当月 212 场，含教室/详情链接）
- 西南财经大学：robots.txt 为 `Disallow: /`，按合规保持禁用并记录备用通道
- 数据从 82 场增至 **121 场（95 场未来）**，覆盖 6 所学校
- 采集分页尊重 `totalPage`，避免重复翻页
- 修复工作台画像计数（`/api/memory` 补 `counts`）
- 新增地图测试；`sources` 测试更新为 7 个已接入源
- 回退：`git reset --hard v3.0.0-m9`

## v3.0.0-m9 · 2026-10-24

**M9：工作台第一版**

- 新增 `src/web/workbench.html`，`/` 显示"今天"：统计、未来 7 天行程、画像、任务、快捷入口
- 对话页迁到 `/chat`，机会日历仍在 `/recruit`；三页统一入口
- 对话侧栏新增「▦ 今天 / 工作台」；日历页顶部改为「今天 / 对话」
- 导出未来 30 天 `.ics`、未登录引导、刷新
- 手机 390×844 实测无横向溢出
- 新增文档 `11-工作台.md` 与桌面/手机截图
- 验证：三个路由 200；桌面/手机无报错；68 项测试保持通过
- 回退：`git reset --hard v3.0.0-m2m4`

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
