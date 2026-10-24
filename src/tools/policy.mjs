// 参数校验与去重：规则从注册表 schema 推导，不再维护第二份字段表。
import {getTool} from './registry.mjs';

export function validateArguments(tool, rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error('工具参数必须是对象');
  const spec = tool.parameters || {};
  const props = spec.properties || {};
  for (const key of Object.keys(rawArgs)) {
    if (!Object.hasOwn(props, key)) throw new Error('工具包含未声明参数：' + key);
  }
  for (const key of spec.required || []) {
    if (rawArgs[key] === undefined || rawArgs[key] === null) throw new Error('缺少参数：' + key);
  }
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    const value = rawArgs[key];
    if (value === undefined) continue;
    let next = value;
    if (def.type === 'string') {
      if (typeof value !== 'string') throw new Error(key + ' 必须是字符串');
      next = value.trim();
      if (!next && (spec.required || []).includes(key)) throw new Error(key + ' 不能为空');
      if (def.maxLength && next.length > def.maxLength) throw new Error(key + ' 不能超过 ' + def.maxLength + ' 个字符');
      if (def.enum && !def.enum.includes(next)) throw new Error(key + ' 取值无效');
    } else if (def.type === 'number') {
      next = Number(value);
      if (!Number.isFinite(next)) throw new Error(key + ' 必须是数字');
      if (def.minimum !== undefined && next < def.minimum) throw new Error(key + ' 不能小于 ' + def.minimum);
      if (def.maximum !== undefined && next > def.maximum) throw new Error(key + ' 不能大于 ' + def.maximum);
    } else if (def.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(key + ' 必须是布尔值');
    }
    out[key] = next;
  }
  return out;
}

// 兼容旧调用：按工具名查注册表再校验
export function validateToolArguments(name, args) {
  const tool = getTool(name);
  if (!tool) throw new Error('工具未开放');
  return validateArguments(tool, args);
}
