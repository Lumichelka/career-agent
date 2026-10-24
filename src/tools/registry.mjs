// 工具注册表：全系统唯一的工具定义来源。
// 模型拿到的 schema、能力面板展示、MCP 暴露、参数校验都从这里生成。
const platform = {type: 'string', enum: ['boss', 'xiaohongshu']};

export const TOOLS = [
  {
    name: 'career_recruit_events',
    title: '查询线下招聘',
    description: '读取本机已采集的线下招聘活动（宣讲会/双选会/就业指导），按时间排序并给出冲突与通勤提示。用于排行程；没有数据时如实说明需要先采集。',
    permission: 'read',
    handler: 'recruit.events',
    timeoutMs: 8000,
    parameters: {
      type: 'object',
      properties: {
        days: {type: 'number', minimum: 1, maximum: 90, description: '未来天数，默认 30'},
        school: {type: 'string', maxLength: 30, description: '学校名，可选'},
        kind: {type: 'string', enum: ['宣讲会', '双选会', '就业指导', '招聘信息', '其他'], description: '活动类型，可选'}
      },
      additionalProperties: false
    }
  },
  {
    name: 'career_company_research',
    title: '公司调研',
    description: '调研一家用人单位：查询公开信息（行业、规模、口碑、校招动态），返回搜索摘要与链接。未配置搜索服务时如实说明，不得编造公司评价或待遇。',
    permission: 'read',
    handler: 'search.company',
    timeoutMs: 25000,
    parameters: {
      type: 'object',
      properties: {
        company: {type: 'string', maxLength: 60, description: '公司全称或常用名'},
        city: {type: 'string', maxLength: 20, description: '城市，可选'}
      },
      required: ['company'],
      additionalProperties: false
    }
  },
  {
    name: 'career_public_search',
    title: '公开搜索',
    description: '通过用户配置的搜索服务查询公开网络，返回实际搜索摘要和链接；未配置时明确不可用，不能编造结果。',
    permission: 'read',
    handler: 'search.public',
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {query: {type: 'string', maxLength: 120, description: '搜索词，不含联系方式'}},
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'career_platform_status',
    title: '平台连接状态',
    description: '检查BOSS和小红书连接状态，不把已打开当已登录。',
    permission: 'read',
    handler: 'platform.status',
    timeoutMs: 8000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  },
  {
    name: 'career_platform_search',
    title: '平台搜索',
    description: '搜索本人按需连接的平台岗位或笔记。未连接会在聊天提示登录并等待选择，不自行登录，不发消息。搜索词不含个人联系方式或完整简历。',
    permission: 'read',
    handler: 'platform.search',
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        platform: {...platform, description: '平台'},
        query: {type: 'string', maxLength: 120, description: '搜索词'}
      },
      required: ['platform', 'query'],
      additionalProperties: false
    }
  },
  {
    name: 'career_platform_read',
    title: '读取平台页面',
    description: '读取专用浏览器当前的岗位/笔记/搜索页面，不读私信、设置或登录凭据。',
    permission: 'read',
    handler: 'platform.read',
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {platform: {...platform, description: '平台'}},
      required: ['platform'],
      additionalProperties: false
    }
  }
];

export function getTool(name) {
  return TOOLS.find(t => t.name === name) || null;
}

export function listTools() {
  return TOOLS.map(({handler, ...rest}) => rest);
}

export function toolsForModel() {
  return TOOLS.map(t => ({name: t.name, description: t.description, parameters: t.parameters}));
}

export function platformTools() {
  return TOOLS.filter(t => t.handler.startsWith('platform.'));
}

export function toolNames() {
  return TOOLS.map(t => t.name);
}
