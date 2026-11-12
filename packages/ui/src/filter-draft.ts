import type { Field, FieldFilter, FilterGroup, FilterOperator } from '../../contracts/src/index.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';

export interface RuleDraft { fieldId: string; operator: FilterOperator; value: FormValue }
export interface GroupDraft { conjunction: 'and' | 'or'; conditions: Array<RuleDraft | GroupDraft> }

export function filterDraft(group: FilterGroup | undefined, fields: Field[]): GroupDraft {
  if (!group) return { conjunction: 'and', conditions: [] };
  return { conjunction: group.conjunction, conditions: group.conditions.map(condition => 'conjunction' in condition
    ? filterDraft(condition, fields) : { ...condition, value: toFormValue(fields.find(field => field.id === condition.fieldId)!, condition.value) }) };
}

export function filterValue(group: GroupDraft, fields: Field[]): FilterGroup {
  return { conjunction: group.conjunction, conditions: group.conditions.map((condition): FieldFilter | FilterGroup => {
    if ('conjunction' in condition) return filterValue(condition, fields);
    const { fieldId, operator, value } = condition;
    if (operator === 'isEmpty' || operator === 'isNotEmpty') return { fieldId, operator };
    const field = fields.find(field => field.id === fieldId)!;
    return { fieldId, operator, value: operator === 'contains' ? value as string ?? ''
      : fromFormValue({ ...field, required: false, ...(field.relation ? { relation: { ...field.relation, multiple: true } } : {}) }, value) };
  }) };
}

export function filterCount(group: GroupDraft): number {
  return group.conditions.reduce((count, condition) => count + 1 + ('conjunction' in condition ? filterCount(condition) : 0), 0);
}

export function filterOperators(field: Field): FilterOperator[] {
  const operators: FilterOperator[] = ['multiSelect', 'relation'].includes(field.type) ? ['hasAny', 'eq', 'neq'] : ['eq', 'neq'];
  if (field.type === 'text' || field.type === 'multiline') operators.push('contains');
  if (field.type === 'number' || field.type === 'date' || field.type === 'datetime') operators.push('gt', 'gte', 'lt', 'lte');
  return [...operators, 'isEmpty', 'isNotEmpty'];
}
