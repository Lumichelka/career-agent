# 职向 v2 · 大学生线下求职智能体

> **当前状态：v2 可运行；v3 方案待你确认，确认前不改代码。**
> 先读：[v3 重构方案](docs/plan/01-v3重构方案.md) · [文件地图](docs/plan/00-文件地图.md) · [待确认问题](docs/plan/05-待确认问题.md) · [文档索引](docs/README.md)

> 从高校就业网采集真实的宣讲会 / 双选会 → 整理成可导入手机日历的行程表 → 结合岗位改简历、做面试准备。
> 所有结论带来源；抓不到就说抓不到。

---

## 快速开始（3 步）

1. 安装 **Node.js 23+**（内置 SQLite）。
2. 双击 **`开始使用.cmd`**。
3. 用 `.data\首次登录.txt` 里的账号登录 → 左侧「模型与接口设置」→ 选预设、填 API Key → **一键体检** → 保存。

想要手机也能用：双击 **`开始使用-局域网.cmd`**，用控制台打印的 `http://192.168.x.x:4189` 访问。

> 详细图文步骤见 [操作手册](docs/04-操作手册.md)。

---

## 它现在能做什么

### 1. 采集真实线下招聘

已接入 5 个可实采信息源（共登记 13 个）：

| 学校 | 通道 | 方式 |
| --- | --- | --- |
| 四川大学 | 宣讲会 / 双选会 | 静态 HTML |
| 上海财经大学 | 宣讲会 | 隐藏 JSON 接口（自动翻页） |
| 南开大学 | 双选会 | 静态列表 + 详情页补全 |
| 中山大学 | 宣讲会摘要 | 静态（详情需校方登录） |

实测采到 **79 场活动**，来自 4 所学校。失败的源会记录原因（如中央财经连接超时、部分站点反爬 403），并在界面上如实标注——**不会把"没抓到"显示成"没有活动"**。

### 2. 整理行程与导出

- 冲突检测：同城时间重叠标红
- 赶场风险：间隔小于估算通勤标橙
- 异地同日：提示"需取舍"，不误报冲突
- 导出：`.ics`（手机日历）/ `.csv`（Excel）/ `.md`（交作业）

### 3. 对话式求职助手

- 读取本机招聘库排行程（`career_recruit_events`）
- 公司公开信息调研（`career_company_research`，需配置搜索服务）
- 简历定向改写（artifact 可下载，禁止编造经历）
- BOSS 直聘 / 小红书按需读取（本人登录，不代投递）

### 4. 模型接入可诊断、可持久、可多端

- 14 个供应商预设（DeepSeek / 智谱 / Kimi / 通义 / 硅基流动 / 火山 / OpenAI / Claude / OpenRouter / Gemini / Ollama / LM Studio / 自建网关 / 自定义）
- API Key **AES-256-GCM 加密落盘**，重启不用重填
- HTTP 代理支持（零依赖 CONNECT 隧道）
- 流式输出、429 自动重试、备用接口自动切换
- **七阶段一键体检**：环境 → 地址 → DNS → 端口 → 证书 → 鉴权 → 工具/JSON

---

## 目录结构

```
server.mjs             HTTP 应用（账号/会话/聊天流/招聘 API）
agent.mjs              智能体循环（规划 → 执行 → 复核）
api-model.mjs          模型接入（流式/重试/工具/JSON 修复）
providers.mjs          供应商预设与地址规范化
proxy-fetch.mjs        HTTP 代理（CONNECT）
keyvault.mjs           API Key 加密存储
diag.mjs               七阶段接口体检
model-settings.mjs     模型配置校验与保存
platforms.mjs          BOSS / 小红书浏览器
index.html + ui-model.js  对话界面 + 模型设置面板

recruit/
  sources.mjs          信息源注册表（13 个源）
  fetch.mjs            抓取（UA/编码/限速/robots/重试）
  browser.mjs          浏览器渲染兜底
  collect.mjs          采集编排 + 字段归一
  store.mjs            SQLite（活动/原始页/运行记录）
  schedule.mjs         排班、冲突、通勤、ICS/CSV/MD
  api.mjs              Web API
  cli.mjs              命令行
  page.html            招聘日历页面

docs/                  审计、方案、部署、手册、答辩
```

---

## 常用命令

```bash
npm start                 # 启动（等同双击 开始使用.cmd）
npm test                  # 32 项自动化测试
node diag-cli.mjs         # 命令行接口体检
node recruit/cli.mjs sources
node recruit/cli.mjs collect --limit 20
node recruit/cli.mjs list --days 30
node recruit/cli.mjs export --format ics --out schedule.ics
node recruit/cli.mjs verify
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 现状审计与重构判定](docs/01-现状审计与重构判定.md) | 原项目问题清单、证据、保留/改造/重写判定 |
| [02 v2 总体方案](docs/02-v2总体方案.md) | 每个环节的 3–6 种实现路径与取舍 |
| [03 接口连接与多设备](docs/03-接口连接与多设备.md) | API 连不上的根因、5 种接口方案、5 种多端方案 |
| [04 操作手册](docs/04-操作手册.md) | 零基础上手、截图、报错对照 |
| [05 答辩要点](docs/05-答辩要点.md) | 逐条对应作业要求、演示脚本、问答准备 |

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
