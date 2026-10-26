// 已登记、尚未接入：本次测试连接超时，属于需求中提到的"抓取失败"。
export default {
  id: 'cufe-scc',
  name: '中央财经大学 · 就业信息网',
  school: '中央财经大学',
  city: '北京',
  category: '财经强校',
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'static',
  capabilities: {list: 'static', detail: 'none', projects: 'none'},
  enabled: false,
  listUrl: 'https://scc.cufe.edu.cn/',
  sourceCheck: {enabled: true},
  note: "当前网络请求失败；重试/浏览器仍失败时只走公众号。",
  fallback: '官方微信公众号「中央财经大学就业指导中心」+ 人工转发链接解析'
};
