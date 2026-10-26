# 验收证据包

这里放两类东西：可执行的验收模板，以及 owner 在真实 live 运行后填写的证据。
每个验收包一个目录，命名 `<编号>-<简称>/`，至少包含 `README.md` 与可校验的清单（如 `manifest.json`）。

## 当前验收包

| 目录 | 对应规格 / 票 | 状态 |
| --- | --- | --- |
| [24-swufe](./24-swufe/README.md) | spec #25 / ticket #42 · 西南财大首个端到端验收 | 模板（pending），待 owner 执行 live 并签字 |

## 规则

1. **不得伪造**：只记录实际发生过的路径、计数、哈希、截图与签字。示例值、占位符、确定性测试输出都不是 live 证据。
2. **确定性回归不等于 live**：`tests/acceptance-swufe.test.mjs` 只证明代码链路可重复；live 必须真实浏览器、真实视觉模型、真实外部 Agent 各成功一次。
3. **个人信息最小化**：含联系方式的原始页面截图不复制进仓库，只记本机路径 + sha256；抽取 JSON、审计导出、复核输出入库前必须已剔除联系方式。
4. **可校验**：完成一份证据包 = README 填完 + 清单文件通过校验器 + 签字区写「验收通过 + 日期」+ 验收人。
5. **模板保持 pending**：只有 owner 在 live 通过、且校验器退出码为 0 后，才能把状态改为 `passed`。
6. **每次复跑都更新**：哈希、截图、DB 快照与计数必须来自同一次 run，不允许沿用上一次。

## 校验命令

```powershell
# 校验一份填写完成的证据清单
node docs/acceptance/24-swufe/verify-evidence.mjs docs/acceptance/24-swufe/manifest.json

# 计算 recruit.db 的 events + event_projects 内容哈希（撤销前后一致性判定）
node docs/acceptance/24-swufe/verify-evidence.mjs --hash-db "<recruit.db 快照路径>"
```
