# 技能目录（Skill）

每个技能一个子目录：

```
<skill-id>/
├─ SKILL.md        # 顶部 --- 元信息：id/name/description/triggers/tools/writes/version
├─ prompt.md       # 给模型的约束（M7 使用）
├─ schema.json     # 输出结构（可选）
└─ checklist.md    # 验收清单（可选）
```

SKILL.md 示例：

```markdown
---
id: company-research
name: 公司调研
description: 查询一家用人单位的公开信息，输出带来源的简报
triggers: [公司怎么样, 这家公司, 口碑]
tools: [career_company_research, career_public_search]
writes: false
version: 1
---
```

能力面板会自动读取并展示这些技能；当前已内置三个：`company-research`、`resume-tailoring`、`interview-prep`（行程规划技能已按新需求移除）。
