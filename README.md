# 职向 v3 · 大学生线下求职智能体

> **当前状态：`v3.2.7`；来源阅读技能含主站+公众号双通道与视觉截图 runbook。**
> 先看：[最终交付清单](docs/plan/18-最终交付清单.md) · [平台与公众号](docs/plan/19-平台与公众号.md) · [日历与项目](docs/plan/20-日历与招聘项目.md) · [CHANGELOG](docs/plan/CHANGELOG.md)
> 数据目录：`%LOCALAPPDATA%\ZhiXiang`（首次启动会自动迁移旧 `.data`）

> 从高校就业网/公众号采集“活动 + 招聘项目” → 在日历里选项目 → 研究公司/岗位要求/薪资 → 结合简历做材料与面试准备。
> 所有结论带来源；抓不到就说抓不到。

---

## 快速开始（3 步）

1. 安装 **Node.js 23+**（内置 SQLite）。
2. 双击 **`开始使用.cmd`**，会自动打开工作台 `http://127.0.0.1:4189/`。
3. 首次会引导到 `/chat` 登录（用 `%LOCALAPPDATA%\ZhiXiang\首次登录.txt` 里的账号）→ 左侧「模型与接口设置」→ 选预设、填 API Key → **一键体检** → 保存。

登录后：`/` 直接进入对话；`/recruit` 是数据页（日历 / 来源）；`/wechat` 重定向到来源 tab；`/resume` 是资料库；`/companies` 已从主界面移除（302 到对话）。

想要手机也能用：双击 **`开始使用-局域网.cmd`**，用控制台打印的 `http://192.168.x.x:4189` 访问。

> 详细图文步骤见 [操作手册](docs/archive/v2/04-操作手册.md)（v2 版，路由以本 README 为准）。

---

## 它现在能做什么

### 1. 采集真实线下招聘

已接入 8 个可自动实采信息源（共登记 13 个；24365/国聘为需登录的 browser 源骨架，不自动采集；公众号 9 个账号另计）：

| 学校 | 通道 | 方式 |
| --- | --- | --- |
| 四川大学 | 宣讲会 / 双选会 | 静态 HTML |
| 四川农业大学 | 校园招聘会 | JSON 接口（校区/教室/起止时间） |
| 西南交通大学 | 宣讲会 / 双选会 | 日历 JSON 接口（一次返回当月） |
| 西南石油大学 | 宣讲会 | 列表 JSON 接口 |
| 西南石油大学 | 双选会 + 参会单位 | 双选会/单位 JSON 接口 |
| 电子科技大学 | 现场招聘 | Nuxt `onSiteCalendar` API |
| 上海财经大学 | 宣讲会 | 隐藏 JSON 接口（自动翻页） |

实测已有 **140+ 场活动、500+ 双选会项目**；西南石油大学、四川大学双选会自动拆参会单位。失败源保留原因/替代路径（中央财经超时、西南财大 robots、UIBE 无结构化活动等）——**不会把“没抓到”显示成“没有活动”**。

### 2. 活动日历、项目与导出

- 月历看板：按天展示活动，点日期/项目看详情
- 一对多：双选会自动挂参会单位项目；支持批量粘贴
- 项目行可“研究 ↗”跳到对话，Agent 读取项目后做岗位要求/薪资调研
- 已暂停冲突/通勤排班（按新需求）
- 导出：`.ics`（手机日历）/ `.csv`（Excel）/ `.md`（交作业）

### 3. 对话式求职助手

- 读取本机招聘库（`career_recruit_events`），按日历列活动与项目
- 公司公开信息调研（`career_company_research`，需配置搜索服务）
- 简历定向改写（`resume_list / resume_read`，禁止编造经历）
- 面试准备（`interview_list / interview_read`，题库 + 我的回答）
- 7 个登录型网站按需读取（BOSS/小红书/实习僧/牛客/智联/51job/猎聘），本人登录、只读浏览；读到的岗位经你确认后才写入招聘项目表（不代投递）；失败可截图 OCR 或系统浏览器打开
- 公众号自动发布与平台岗位写入都会落 `write_audit`；演示数据清理改为软删除 + 审计，不再直接 `DELETE`

### 4. 工作台与求职材料

- `/` 今天：未来 7 天、招聘项目、画像、任务、导出日历
- `/recruit` 活动日历 / 项目 / 采集 / 手动导入
- `/wechat` 公众号账号与文章记录
- `/resume` 简历库 / 投递跟进 / 面试准备
- 对话生成的简历或面试稿可一键保存，点按钮才算确认

### 5. 多端与备份

- 同一 Wi-Fi：`开始使用-局域网.cmd`
- 跨网络：Tailscale（见 [部署文档](docs/plan/14-部署与备份.md)）
- Docker：`docker compose up -d --build`（本机无 Docker，未实测）
- 备份：`node scripts/backup.mjs`，保留最近 5 份并写清单

### 6. 模型接入可诊断、可持久、可多端

- 14 个供应商预设（DeepSeek / 智谱 / Kimi / 通义 / 硅基流动 / 火山 / OpenAI / Claude / OpenRouter / Gemini / Ollama / LM Studio / 自建网关 / 自定义）
- API Key **AES-256-GCM 加密落盘**，重启不用重填
- HTTP 代理支持（零依赖 CONNECT 隧道）
- 流式输出、429 自动重试、备用接口自动切换
- **七阶段一键体检**：环境 → 地址 → DNS → 端口 → 证书 → 鉴权 → 工具/JSON

---

## 目录结构

完整文件地图见 [00-文件地图](docs/plan/00-文件地图.md)。

```
src/
├─ server/    app.mjs（路由/账号/分发）、accounts.mjs
├─ agent/     提示词、上下文、三层记忆、计划
├─ model/     协议、供应商、Key、代理、体检
├─ tools/     15 个工具（registry/policy/execute/handlers）
├─ skills/    4 个技能包（公司调研/简历定向/面试准备/来源阅读）
├─ recruit/   采集、生命周期、日历、项目、手动导入
├─ resume/    简历版本、投递、面试、Word
├─ company/   公司档案
├─ wechat/    公众号账号/文章
├─ platform/  7 个登录型网站、截图 OCR、MCP 桥
├─ config/    数据目录
└─ web/       工作台/对话/日历/简历/公司/公众号
```

运行数据：`recruit.db` / `resume.db` / `company.db` / `wechat.db` / `memory/` / 会话 / 登录态，全部在项目外。

---

## 常用命令

```bash
npm start                 # 启动（等同双击 开始使用.cmd）
npm test                  # 自动化测试（全部通过）
npm run check             # 环境 + 数据 + 测试 一键自检
node src/recruit/cli.mjs sources
node src/recruit/cli.mjs collect --limit 20
node src/recruit/cli.mjs list --days 30
node src/recruit/cli.mjs export --format ics --out schedule.ics
node src/recruit/cli.mjs verify
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 现状审计与重构判定](docs/archive/v2/01-现状审计与重构判定.md) | 原项目问题清单、证据、保留/改造/重写判定 |
| [02 v2 总体方案](docs/archive/v2/02-v2总体方案.md) | 每个环节的 3–6 种实现路径与取舍 |
| [03 接口连接与多设备](docs/archive/v2/03-接口连接与多设备.md) | API 连不上的根因、5 种接口方案、5 种多端方案 |
| [04 操作手册](docs/archive/v2/04-操作手册.md) | 零基础上手、截图、报错对照 |
| [05 答辩要点](docs/archive/v2/05-答辩要点.md) | 逐条对应作业要求、演示脚本、问答准备 |

---

## 合规与隐私

- 只读取公开页面；遵守 `robots.txt`；同域限速。
- 不代投递、不发消息、不抓私信、不读取登录凭据。
- 平台登录由本人在专用浏览器完成；智能体只读可见内容。
- 账号密码 scrypt 加盐；API Key 加密存储；不同账号数据隔离。
- **不要分享 `.data` 目录**：里面有简历、账号、密钥与登录状态。

---

## 许可

课程项目，仅供学习与内部测试使用。采集数据版权归原高校/单位所有，引用请保留来源链接。
