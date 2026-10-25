// 工具注册表：全系统唯一的工具定义来源。
// 模型拿到的 schema、能力面板展示、MCP 暴露、参数校验都从这里生成。
import {PLATFORM_IDS, PLATFORM_SITES} from '../platform/sites.mjs';

const platform = {type: 'string', enum: PLATFORM_IDS, description: '登录型网站：' + PLATFORM_IDS.map(id => PLATFORM_SITES[id].name).join('、')};

export const TOOLS = [
  {
    name: 'company_list',
    title: '公司档案列表',
    description: '列出本机保存的公司档案（行业/城市/更新时间）。',
    permission: 'read',
    handler: 'company.list',
    timeoutMs: 5000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  },
  {
    name: 'company_read',
    title: '读取公司档案',
    description: '按 id 或公司名读取一份公司档案（介绍/前景/评价/待遇/文化/来源）。',
    permission: 'read',
    handler: 'company.read',
    timeoutMs: 5000,
    parameters: {
      type: 'object',
      properties: {
        id: {type: 'string', maxLength: 36, description: '档案 id，可选'},
        name: {type: 'string', maxLength: 80, description: '公司名称，可选'}
      },
      additionalProperties: false
    }
  },
  {
    name: 'interview_list',
    title: '面试准备列表',
    description: '列出本机保存的面试准备（公司/岗位/题目数/已答数）。',
    permission: 'read',
    handler: 'interview.list',
    timeoutMs: 5000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  },
  {
    name: 'interview_read',
    title: '读取面试准备',
    description: '读取一份面试准备的内容与题库（含我的回答）。id 可选，缺省读最近一份。',
    permission: 'read',
    handler: 'interview.read',
    timeoutMs: 5000,
    parameters: {
      type: 'object',
      properties: {id: {type: 'string', maxLength: 36, description: '面试准备 id，可选'}},
      additionalProperties: false
    }
  },
  {
    name: 'resume_list',
    title: '简历列表',
    description: '列出本机保存的简历与版本数量，用于了解用户有哪些简历版本。',
    permission: 'read',
    handler: 'resume.list',
    timeoutMs: 5000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  },
  {
    name: 'resume_read',
    title: '读取简历',
    description: '读取某份简历的最新版本正文与标题。id 可选，缺省读第一份；需要 id 时先用 resume_list 查。',
    permission: 'read',
    handler: 'resume.read',
    timeoutMs: 5000,
    parameters: {
      type: 'object',
      properties: {id: {type: 'string', maxLength: 36, description: '简历 id，可选'}},
      additionalProperties: false
    }
  },
  {
    name: 'career_recruit_events',
    title: '查询线下招聘',
    description: '读取本机已采集的线下招聘活动（宣讲会/双选会/就业指导），按日历列出活动及其关联招聘项目。行程冲突与通勤规划已暂停；没有数据时如实说明需要先采集。',
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
    name: 'career_recruit_projects',
    title: '查询招聘项目',
    description: '从本机已采集的活动下查询招聘项目（单位/岗位/要求/投递/来源）。项目来源是高校就业网或公众号；平台工具只用于研究岗位要求和薪资，不在这里登记岗位或投递。',
    permission: 'read',
    handler: 'recruit.projects',
    timeoutMs: 8000,
    parameters: {
      type: 'object',
      properties: {
        days: {type: 'number', minimum: 1, maximum: 180, description: '未来天数，默认 30'},
        school: {type: 'string', maxLength: 30, description: '学校名，可选'},
        company: {type: 'string', maxLength: 60, description: '单位名，可选'},
        q: {type: 'string', maxLength: 60, description: '关键词（单位/岗位/要求），可选'},
        limit: {type: 'number', minimum: 1, maximum: 100, description: '最多返回条数，默认 50'}
      },
      additionalProperties: false
    }
  },
  {
    name: 'career_recruit_project',
    title: '招聘项目详情',
    description: '读取单个招聘项目及其所属活动、来源链接，用于后续研究该公司/岗位要求。',
    permission: 'read',
    handler: 'recruit.project',
    timeoutMs: 8000,
    parameters: {
      type: 'object',
      properties: {id: {type: 'string', maxLength: 64, description: '项目 id'}},
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'career_recruit_bulk_write',
    title: '批量写入招聘活动与项目',
    description: '把从页面或截图核对出的活动与参会单位一次写入本机招聘库（自动写入，带审计与幂等）。只写 events / event_projects，不写公司档案、不投递。events 每条需 title 与 startAt；projects 用 eventIndex（从 0 开始）或 eventId 指向同批活动；source.sourceId=manual 表示手动/浏览器读取。同一次调用共用一个 idempotencyKey，重试不会重复写入。',
    permission: 'write',
    sensitivity: 'auto',
    writeDomain: 'recruit',
    handler: 'recruit.bulkWrite',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        events: {type: 'array', description: '活动数组（最多 50 条），每项含 title、startAt，可选 school/city/kind/venue/company/positions/requirements/applyMode/applyUrl/sourceUrl/sourceKey/notes'},
        projects: {type: 'array', description: '招聘项目数组（最多 200 条），用 eventIndex（从 0 开始）或 eventId 关联本批活动'},
        source: {
          type: 'object',
          description: '来源元数据：sourceId（manual=手动/浏览器读取）、sourceUrl、notes',
          properties: {
            sourceId: {type: 'string', maxLength: 80},
            sourceUrl: {type: 'string', maxLength: 500},
            notes: {type: 'string', maxLength: 2000}
          },
          additionalProperties: false
        },
        idempotencyKey: {type: 'string', maxLength: 200, description: '幂等键：同一次写入重试必须复用'},
        confirmId: {type: 'string', maxLength: 64, description: '敏感写入的确认 id，可选'}
      },
      required: ['events'],
      additionalProperties: false
    }
  },
  {
    name: 'career_profile_write',
    title: '写入长期画像',
    description: '把用户确认过的长期画像条目（届别/专业/城市偏好/技能/经历要点）写入本机画像库。这是敏感写入：调用后只生成待确认记录、不落库，需用户在任务卡点「接受」后才保存；不接受时不要自己填 confirmId。一次调用 = 一个批次，重试要复用同一个 idempotencyKey。',
    permission: 'write',
    sensitivity: 'sensitive',
    writeDomain: 'profile',
    handler: 'profile.write',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          description: '画像条目数组（1-50 条）；每项含 key（要点名，≤40 字）与 value（内容，≤500 字），可选 source',
          items: {
            type: 'object',
            properties: {
              key: {type: 'string', maxLength: 40},
              value: {type: 'string', maxLength: 500},
              source: {type: 'string', maxLength: 80}
            },
            required: ['key', 'value']
          }
        },
        idempotencyKey: {type: 'string', maxLength: 200, description: '幂等键：同一次写入重试必须复用'},
        confirmId: {type: 'string', maxLength: 64, description: '确认接口内部使用；模型不要填写'}
      },
      required: ['facts', 'idempotencyKey'],
      additionalProperties: false
    }
  },
  {
    name: 'career_source_health',
    title: '招聘来源健康',
    description: '列出高校就业网/公众号来源的列表、详情、项目能力与最近状态；ok 只在列表解析成功时使用。',
    permission: 'read',
    handler: 'recruit.sources',
    timeoutMs: 8000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
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
    description: '检查登录型网站（BOSS、小红书、实习僧、牛客、智联、51job、猎聘）的连接状态，不把已打开当已登录。',
    permission: 'read',
    handler: 'platform.status',
    timeoutMs: 8000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  },
  {
    name: 'career_platform_search',
    title: '平台搜索',
    description: '搜索本人按需连接的登录型网站（岗位/实习/笔记）。未连接会在聊天提示登录并等待选择，不自行登录，不发消息。搜索词不含个人联系方式或完整简历。',
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
    description: '读取专用浏览器当前的岗位/实习/笔记/搜索页面；DOM 读取失败时会尝试截图 OCR，不读私信、设置或登录凭据。',
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
  // 自动/敏感分级与写入域随注册表一起给能力面板；旧工具没有显式声明时按自动只读处理。
  return TOOLS.map(({handler, ...rest}) => ({...rest, sensitivity: rest.sensitivity || 'auto', writeDomain: rest.writeDomain || ''}));
}

export function toolsForModel() {
  return TOOLS.map(t => ({name: t.name, description: t.description, parameters: t.parameters}));
}

export function platformTools() {
  return TOOLS.filter(t => t.handler.startsWith('platform.'));
}

// 入站 /mcp 暴露的工具：注册表里除平台工具以外的本地只读工具。
// 平台工具是任务内的登录型浏览器操作，靠内部任务桥与 taskId 鉴权；入站连接没有任务，因此不暴露。
// 写工具在入站确认链路（#30/#38）接好前不暴露：入站调用没有本应用的 confirm_id 身份，不能绕过确认直接写库。
export function inboundTools() {
  return TOOLS.filter(t => !t.handler.startsWith('platform.') && t.permission !== 'write');
}

export function toolNames() {
  return TOOLS.map(t => t.name);
}
