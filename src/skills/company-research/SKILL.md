---
id: company-research
name: 公司调研
description: 查询一家用人单位的公开信息，输出带来源的简报
triggers: [公司怎么样, 这家公司, 公司调研, 口碑, 待遇怎么样]
tools: [career_company_research, career_public_search]
writes: false
version: 1
---

# 何时使用

用户拿到一场宣讲会/双选会，想先了解这家公司值不值得去。

# 步骤

1. 确认公司全称（同名公司要区分城市/行业）。
2. 调用 `career_company_research`；必要时用 `career_public_search` 补充。
3. 按固定结构输出，逐条标来源。
4. 没查到的字段写"未查到"，不推测。

# 边界

- 不推算录用率、匹配度、面试通过率。
- 薪酬与评价只引用来源原文，标注主观性与样本局限。
- 来源要带查询日期。
