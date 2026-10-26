// 24365 全国平台：browser 源骨架。必须登录/人工确认，不做自动登录、不绕过验证。
// 只作为可选平台源开放（来源校对/手动导入），不参与默认批量采集，也不计入高校覆盖率。
export default {
  id: 'ncss',
  name: '国家大学生就业服务平台（24365）',
  school: '全国',
  city: '全国',
  category: '双选会平台',
  channel: '官方平台',
  kind: '双选会',
  mode: 'browser',
  capabilities: {list: 'browser', detail: 'none', projects: 'none'},
  enabled: true,
  loginRequired: true,
  manualConfirm: true,
  collectMode: 'manual',
  listUrl: 'https://www.ncss.cn/',
  sourceCheck: {enabled: true},
  // browser 骨架：真实列表在登录后由页面渲染，自动流程不解析、不猜；保留接缝给后续人工确认路径。
  parseList() { return []; },
  note: '需登录/人工确认：不自动采集、不绕过登录；用来源校对或手动导入。'
};
