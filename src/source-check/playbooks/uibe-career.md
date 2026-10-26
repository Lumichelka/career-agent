---
id: uibe-career
title: 对外经济贸易大学 · AI 兜底 playbook
version: 1
updatedAt: 2026-10-27
sourceIds:
  - uibe-career
aliases:
  - uibe
  - 对外经贸
entry:
  - https://career.uibe.edu.cn/front/channel.jspa?channelId=766&parentId=625
detailSelector: a[href*="/front/zph.jspa"]
domains:
  - career.uibe.edu.cn
successMarkers:
  - 列表页出现 ≥1 场招聘活动，每条都有标题与可点开的详情链接
  - 详情页能读到单位名称、举办时间与地点（缺项留空，不猜）
  - 每步都有截图与 action.jsonl，单次运行在 10 分钟内结束
forbiddenActions:
  - 投递、报名、支付、删除、退出登录
  - 提交任何表单（除非用户在任务卡上明确接受）
  - 下载、上传文件
  - 绕过登录、验证码或站点反爬限制
  - 访问 file:/chrome:/edge:/localhost 与私网地址
extractHints:
  - 每条活动至少要有标题、合法的开始时间与来源详情 URL
  - 单位、地点、岗位按页面原文填写；页面没写就留空，不编造
  - 保留详情页 URL 与每一步截图，作为可追溯证据
---

# 对外经济贸易大学 · AI 兜底 playbook

**这是兜底，不是自动采集。** 对外经贸已经有确定性解析器（列表每页 20 条、共 202 页）；
只有确定性采集失败、被阻断、页面结构变化，或用户主动点「AI 兜底」时才走这份 playbook。
不因为一次失败就自动切换，也不定时运行。

## 入口

1. 打开 https://career.uibe.edu.cn/front/channel.jspa?channelId=766&parentId=625
2. 页面由站点 JS 渲染；等待列表出现即可，不要直接请求加密查询接口（robots 禁止）。
3. 活动详情是 `/front/zph.jspa?tid=...` 的静态 HTML，点开一条确认结构。

## 登录与人工接管

- 该源公开可读，通常不需要登录；出现验证/登录时暂停，用户在可见窗口处理后点「已登录，继续」。
- 不绕过验证码，不提取 cookie，不模拟登录。

## 成功判定

- 列表有活动条目，详情含单位、时间、地点；截图与动作日志齐全。
- 抽到的每条记录都能追到详情 URL，字段缺失就留空。

## 边界

- 只读公开页面；投递/支付/删除/退出/提交表单由 operator 的硬确认拦住。
- 单次总活跃时间 <10 分钟；到点暂停等待人工接管，继续后额度不清零。
- **robots 未确认前默认不自动采集**：页面自身 JS 仍会 POST /front/zp_query/，而 robots.txt
  禁止该路径；确定性源 `uibe-career` 因此默认 `enabled:false`，本 playbook 只用于人工点击的兜底/来源校对。
- 详情页逐条请求间隔 1.2s（`detailDelayMs`）；列表每页 20 条、共 202 页。
