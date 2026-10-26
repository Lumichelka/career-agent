// 已登记、尚未接入：站点可达，栏目结构待适配。
export default {
  id: 'uibe-career',
  name: '对外经济贸易大学 · 就业创业指导中心',
  school: '对外经济贸易大学',
  city: '北京',
  category: '财经强校',
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'static',
  capabilities: {list: 'static', detail: 'http', projects: 'none'},
  enabled: false,
  listUrl: 'https://career.uibe.edu.cn/',
  sourceCheck: {enabled: true},
  note: "首页可开但被全屏国聘 banner 覆盖，无结构化活动；使用手工粘贴 HTML/正文或公众号。"
};
