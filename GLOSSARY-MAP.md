# Glossary Map

## Contexts

- [Server](./src/server/GLOSSARY.md): 网页、HTTP API 与 MCP 入站
- [Source check](./src/source-check/GLOSSARY.md): 难源操作、playbook 与对外信息流

## Relationships

- **Source check → Server**: 来源操作复用 source-check 任务；信息流经入站 MCP 暴露给外部 AI。

- **入站 ↔ 出站**: 同一进程里的两个方向；凭据、transport 与超时策略互不共用。
