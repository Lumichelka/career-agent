# Source Check

难源操作、playbook 与对外信息流的上下文。

## Language

**来源操作（Source Operation）**:
AI 在浏览器中为一个难源读取数据的过程；由用户手动触发、可见窗口运行。
_Avoid_: AI 代采集、自动爬取

**操作任务（Operation Task）**:
带 operator 阶段的 source-check 任务，承载登录、动作证据、抽取、复核与写入。
_Avoid_: 采集任务、AI 任务

**playbook**:
每个难源的入口、成功标志、禁止动作与抽取提示，是可评审的源知识。
_Avoid_: 提示词、脚本配置

**信息流（Feed）**:
规范化记录加上增量游标，供本应用与外部 AI 消费的视图；权威数据仍在本地审计库。
_Avoid_: AI 数据库、第二份数据

**证据引用（Evidence Ref）**:
指向本地任务证据的标识，不代表证据永久可用。
_Avoid_: 证据文件、截图链接

**脱敏原文（Redacted Raw Text）**:
移除手机号、邮箱、身份证、微信、联系人后的页面文本，单条有长度上限。
_Avoid_: 原始 HTML、全文

**硬确认（Hard Confirmation）**:
对投递、支付、删除、退出、提交表单等危险动作的确定性暂停确认；不承诺防任意 JS 绕过。
_Avoid_: 安全沙箱、权限系统

**人工接管（Human Takeover）**:
操作任务暂停后由用户在当前浏览器完成登录/验证码/异常处理，再让任务从停点继续。
_Avoid_: 失败重跑、人工替代

**应用 profile（App Profile）**:
应用自己持有的浏览器登录态目录，不是用户日常浏览器。
_Avoid_: 用户浏览器、BrowserSkill profile
