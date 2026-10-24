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
- 抓不到就 `enabled: false` 并写 `note`，不要把"没抓到"显示成"没有活动"；
- 返回的 `startAt` 必须是带 `+08:00` 的 ISO 时间，否则会被丢弃。
