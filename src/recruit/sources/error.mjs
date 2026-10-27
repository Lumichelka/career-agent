// 源适配器的分类错误：采集器把 kind 转成 runs/健康面板状态，不吞错。
export class SourceError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
  }
}
