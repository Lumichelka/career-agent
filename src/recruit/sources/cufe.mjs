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
  enabled: false,
  listUrl: 'https://scc.cufe.edu.cn/',
  note: '本次测试连接超时（可能是站点侧 IP 限制或网络策略），需要备用通道。',
  fallback: '官方微信公众号「中央财经大学就业指导中心」+ 人工转发链接解析'
};
