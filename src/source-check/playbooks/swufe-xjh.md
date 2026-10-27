---
id: swufe-xjh
title: 西南财经大学 · AI 兜底 playbook
version: 1
updatedAt: 2026-10-27
sourceIds:
  - swufe-xjh
aliases:
  - swufe
  - 西南财大
  - 西南财经大学
entry:
  - https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm
detailSelector: a[href*="/jobfair/jobfair-show-"]
domains:
  - job3.swufe.edu.cn
successMarkers:
  - 列表页出现双选会/招聘会条目，含举办时间与举办地点
  - 详情页能读到参会单位或招聘项目（没有就留空，不编造）
  - 每步都有截图与 action.jsonl，单次运行在 10 分钟内结束
forbiddenActions:
  - 投递、报名、支付、删除、退出登录
  - 提交任何表单（除非用户在任务卡上明确接受）
  - 下载、上传文件
  - 绕过登录、验证码（页面上的腾讯验证码 iframe）或站点反爬限制
  - 访问 file:/chrome:/edge:/localhost 与私网地址
extractHints:
  - 每条双选会至少要有标题、合法的开始时间与来源详情 URL
  - 地点按页面原文填写；没有写地点就留空
  - 参会单位只在详情页明确列出时抽取，猜不到就不写
  - 保留详情页 URL 与每一步截图，作为可追溯证据
---

# 西南财经大学 · AI 兜底 playbook

**这是兜底，不是自动采集。** 西南财大继续保留 source-check 固定两页读取；
AI 兜底只在 source-check 失败、被阻断或用户主动点击时运行，且与 source-check 复用同一套任务、证据与写入网关。

## 入口

1. 打开 https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm
2. 列表项形如 `/jobfair/jobfair-show-<id>.htm`，点开一条确认详情结构。
3. 页面可能出现腾讯验证码 iframe；能正常浏览就继续，被阻断就停。

## 登录与人工接管

- 公开列表通常不需要登录；出现验证码/访问限制时暂停，交给人处理，不绕过。
- 处理完点「已处理，继续」从停点续跑，不重跑已完成步骤。

## 成功判定

- 列表有条目，详情有单位/时间/地点；或明确记录「详情页没有列出参会单位」。
- 抽取结果与 source-check 的对照数据一致；不一致时优先相信页面原文并留证据。

## 边界

- 只读公开页面；提交表单/投递/支付等动作必须硬确认。
- 单次 <10 分钟；超时暂停转人工。
