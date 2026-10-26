// 敏感写入的重放实现：接受确认时按确认里保存的原参数、在同一个事务里重新执行业务写入。
import {WriteError} from './gateway.mjs';
import {validateProfileFacts, writeProfileFacts} from '../profile/store.mjs';

export const WRITE_EXECUTORS = {
  career_profile_write: ({db, userId, payload}) => {
    const invalid = validateProfileFacts(payload?.facts);
    if (invalid) throw new WriteError('CONFIRMATION_MISMATCH', '确认里保存的画像参数已不合法，请重新发起写入。', 422);
    return writeProfileFacts({db, userId, facts: payload.facts.map(fact => ({key: fact.key, value: fact.value, source: fact.source || ''}))});
  }
};
