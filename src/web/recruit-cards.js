// 招聘项目卡的可读字段：岗位、要求、备注都要展示；缺字段明确标「未公布」，不用空白糊过去。
const text = value => String(value ?? '').trim();

export function projectCardMeta(project = {}) {
  const positions = text(project.positions);
  const requirements = text(project.requirements);
  const rawNotes = text(project.notes);
  const missing = [];
  if (!positions) missing.push('岗位未公布');
  if (!requirements) missing.push('要求未公布');
  const notes = [rawNotes, ...missing].filter(Boolean).join('；');
  const details = [];
  if (positions) details.push({label: '岗位', value: positions});
  if (requirements) details.push({label: '要求', value: requirements});
  if (notes) details.push({label: '说明', value: notes});
  return {positions, requirements, notes, published: missing.length === 0, details};
}
