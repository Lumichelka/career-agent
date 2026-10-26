// 已登记、尚未接入：央国企校招聚合，页面为前端渲染。
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
  enabled: false,
  listUrl: 'https://www.iguopin.com/',
  sourceCheck: {enabled: true},
  note: "央国企校招聚合，前端渲染/需登录；作为可选平台源。"
};
