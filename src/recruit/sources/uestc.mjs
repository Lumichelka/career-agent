// 已登记、尚未接入：单页应用，需要浏览器渲染。
export default {
  id: 'uestc-xjh',
  name: '电子科技大学 · 宣讲会',
  school: '电子科技大学',
  city: '成都',
  category: '四川双一流',
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'browser',
  capabilities: {list: 'browser', detail: 'none', projects: 'none'},
  enabled: false,
  listUrl: 'https://jiuye.uestc.edu.cn/career/',
  note: "SPA；需要浏览器渲染与站内路由发现，未登录/未适配前不产生活动。"
};
