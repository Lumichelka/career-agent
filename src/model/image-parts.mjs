// 图片附件的请求体形状：chat 用 image_url，messages 用 base64 source，responses 用 input_image。
// 这是唯一实现：api-model 与 backends 都从这里取，避免两份协议开关逐渐漂移。
// 日志、证据与调用记录只记 name/mime/bytes，绝不写 dataUrl。
export function imageContentFor(protocol, images = []) {
  const list = (Array.isArray(images) ? images : []).filter(image => image && typeof image.dataUrl === 'string');
  if (!list.length) return null;
  if (protocol === 'messages') return list.map(image => ({
    type: 'image',
    source: {type: 'base64', media_type: image.mime || 'image/png', data: image.dataUrl.replace(/^data:[^;]+;base64,/, '')}
  }));
  if (protocol === 'responses') return list.map(image => ({type: 'input_image', image_url: image.dataUrl}));
  return list.map(image => ({type: 'image_url', image_url: {url: image.dataUrl}}));
}
