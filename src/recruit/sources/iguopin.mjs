// 国聘校园招聘：browser 源骨架。页面前端渲染且需登录，不做自动登录、不绕过验证。
// 只作为可选平台源开放（来源校对/手动导入），不参与默认批量采集，也不计入高校覆盖率。
export default {
  id: 'iguopin',
  name: '国聘 · 校园招聘',
  school: '全国',
  city: '全国',
  category: '双选会平台',
  channel: '官方平台',
  kind: '招聘信息',
  mode: 'browser',
  capabilities: {list: 'browser', detail: 'none', projects: 'none'},
  enabled: true,
  loginRequired: true,
  manualConfirm: true,
  collectMode: 'manual',
  listUrl: 'https://www.iguopin.com/',
  sourceCheck: {enabled: true},
  parseList() { return []; },
  note: '需登录/人工确认：前端渲染且需登录，不自动采集、不绕过登录；用来源校对或手动导入。'
};
