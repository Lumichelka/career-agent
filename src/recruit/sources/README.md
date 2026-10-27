# 信息源插件

每个文件导出一个源对象；`index.mjs` 自动扫描本目录（忽略 `index.mjs` 和 `common.mjs`）。

```js
export default {
  id: 'scu-employ',
  name: '四川大学 · 校园宣讲会',
  school: '四川大学',
  city: '成都',
  category: '四川双一流',   // 四川双一流 / 财经强校 / 双选会平台 / 其他高校单位
  channel: '就业信息网',
  kind: '宣讲会',
  mode: 'static',          // static | json | browser | rss | manual
  enabled: true,
  listUrl: 'https://...',
  note: '来源说明 / 已知限制',
  fallback: '可选：失败时的替代通道',
  parseList(html, source) { return [{title, startAt, venue, url, ...}]; },
  // json 模式签名：parseList(_html, source, json)
  // 详情页：detail: true + parseDetail(text, item)
  // 列表需要浏览器渲染或翻页：fetchList({source, limit, onLog, fetchText}) → items | {items, pageCount, pages}
  //   提供 fetchList 时优先于按 mode 抓取；detailAll: true 表示列表已有地点也要逐条抓详情
  // 可选：collectLimit 是未显式传 limit 时的默认上限；翻页失败请 throw SourceError，不要吞成半页成功
};
```

## 新增一所学校

1. 复制同 `mode` 的文件改名；
2. 改 `id/name/school/city/category/listUrl`；
3. 写 `parseList`（用真实页面调试）；
4. `node src/recruit/cli.mjs collect --source <id> --limit 5`；
5. `npm test`（注册表完整性测试会自动覆盖）。

## 注意

- 只读公开页面；遵守 robots.txt 与同域限速；
- 「不直连查询接口」不等于合规：如果页面自身 JS 会 POST robots 禁止的接口（例如 UIBE 的
  /front/zp_query/），默认 `enabled:false` 并在 `note` 标「需人工确认 robots」，不要声称已合规；
- 抓不到就 `enabled: false` 并写 `note`，不要把"没抓到"显示成"没有活动"；
- 列表级源（多场共用一个列表页、没有独立详情页）的 `url` 可以留空，但要在 `notes` 标“无详情链接”；
- 适配器不要自己吞错：翻页/接口失败抛 `SourceError(kind, message)`（kind: blocked / login_required / changed / network / empty / parse），由采集器统一记录；
- 返回的 `startAt` 必须是带 `+08:00` 的 ISO 时间，否则会被丢弃。
