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
id: schedule-planner
name: 行程规划
description: 按天/周整理线下招聘，检查冲突与通勤
triggers: [排行程, 这周有什么, 冲突]
tools: [career_recruit_events]
writes: false
version: 1
---
```

能力面板会自动读取并展示这些技能；当前已内置四个：`schedule-planner`、`company-research`、`resume-tailoring`、`interview-prep`。
