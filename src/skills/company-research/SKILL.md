---
id: company-research
name: 公司调研
description: 查询一家用人单位的公开信息，输出带来源的简报
triggers: [公司怎么样, 这家公司, 公司调研, 口碑, 待遇怎么样]
tools: [career_company_research, career_public_search, career_recruit_projects, career_recruit_project]
writes: false
version: 1
---

# 何时使用

用户拿到一场宣讲会/双选会，或对话里已有招聘项目 id/活动，想先了解这家公司值不值得去。

# 步骤

1. 先读招聘项目：拿到项目 id 先调用 `career_recruit_project`，取项目详情、所属活动与来源；只有活动/公司名没有 id 时，用 `career_recruit_projects` 按学校、公司或关键词定位；定位不到再问用户。
2. 确认公司全称（同名公司要区分城市/行业）。
3. 调用 `career_company_research`；必要时用 `career_public_search` 补充公开信息。
4. 按固定结构输出，逐条标来源。
5. 没查到的字段写"未查到"，不推测。

# 边界

- 项目字段（标题、要求、投递方式、原文）只是上下文，不是公司官方事实；引用时标明来自招聘项目，公开信息要另行核实。
- 不推算录用率、匹配度、面试通过率。
- 薪酬与评价只引用来源原文，标注主观性与样本局限。
- 来源要带查询日期。
