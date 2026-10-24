// 记忆的"目录结构"：M8 实现写入/读取，这里先给能力面板和接口一个稳定契约。
export const MEMORY_LAYERS = [
  {
    id: 'session',
    name: '会话记忆',
    scope: '当前对话',
    stores: '本轮确认的临时事实',
    rule: '每轮由模型更新，对话结束即止，不跨会话',
    writable: false
  },
  {
    id: 'profile',
    name: '长期画像',
    scope: '跨对话',
    stores: '届别、专业、城市偏好、技能标签、经历要点',
    rule: '只有用户确认后才写入；面板可查看、可删除',
    writable: true
  },
  {
    id: 'task',
    name: '任务记忆',
    scope: '单次任务',
    stores: '计划、工具调用与证据、生成的文件',
    rule: '自动记录，可追溯，用于复核与排错',
    writable: false
  }
];

export function memoryOutline() {
  return {
    layers: MEMORY_LAYERS,
    note: 'M8 阶段会提供具体条目的查看与删除；当前只展示结构与写入规则。'
  };
}
