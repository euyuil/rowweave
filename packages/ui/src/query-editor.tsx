import React from 'react';
import type { Field, FilterOperator, SortRule } from '../../contracts/src/index.js';
import { FieldInput } from './field-input.js';
import { filterCount, filterOperators, type GroupDraft, type RuleDraft } from './filter-draft.js';

const operatorNames: Record<FilterOperator, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most',
  isEmpty: 'is empty', isNotEmpty: 'is not empty', hasAny: 'has any of',
};

export function QueryEditor({ fields, filter, sort, onFilter, onSort }: {
  fields: Field[]; filter: GroupDraft; sort: SortRule[];
  onFilter(value: GroupDraft): void; onSort(value: SortRule[]): void;
}) {
  const count = filterCount(filter);
  return <>
    <section className="query-section" aria-label="Filters"><div className="query-heading"><h3>Filters</h3>
      <button type="button" disabled={!filter.conditions.length && filter.conjunction === 'and'} onClick={() => onFilter({ conjunction: 'and', conditions: [] })}>Clear filters</button></div>
      <FilterGroupEditor fields={fields} group={filter} onChange={onFilter} remaining={100 - count} />
      <small>{count} / 100 conditions</small>
    </section>
    <section className="query-section" aria-label="Sorting"><div className="query-heading"><h3>Sorting</h3>
      <button type="button" disabled={!sort.length} onClick={() => onSort([])}>Clear sorting</button></div>
      <p className="form-note">Earlier rules take priority. Records with equal values keep their original order.</p>
      {sort.map((rule, index) => <div className="sort-rule" role="group" aria-label={`Sort ${index + 1}`} key={index}>
        <select aria-label="Sort field" value={rule.fieldId} onChange={event => onSort(sort.map((item, i) => i === index ? { ...item, fieldId: event.target.value } : item))}>
          {fields.map(field => <option key={field.id} value={field.id} disabled={sort.some((item, i) => i !== index && item.fieldId === field.id)}>{field.name}</option>)}
        </select>
        <select aria-label="Sort direction" value={rule.direction} onChange={event => onSort(sort.map((item, i) => i === index ? { ...item, direction: event.target.value as 'asc' | 'desc' } : item))}>
          <option value="asc">Ascending</option><option value="desc">Descending</option>
        </select>
        <button type="button" aria-label={`Move sort ${index + 1} up`} disabled={index === 0} onClick={() => {
          const next = [...sort]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onSort(next);
        }}>↑</button>
        <button type="button" aria-label={`Remove sort ${index + 1}`} onClick={() => onSort(sort.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <button type="button" disabled={sort.length === fields.length} onClick={() => onSort([...sort, {
        fieldId: fields.find(field => !sort.some(rule => rule.fieldId === field.id))!.id, direction: 'asc',
      }])}>Add sort</button>
    </section>
  </>;
}

function FilterGroupEditor({ fields, group, onChange, remaining, depth = 0, path = '1' }: {
  fields: Field[]; group: GroupDraft; onChange(group: GroupDraft): void; remaining: number; depth?: number; path?: string;
}) {
  const replace = (index: number, value: GroupDraft | RuleDraft) => onChange({ ...group, conditions: group.conditions.map((item, i) => i === index ? value : item) });
  return <div className="filter-group" role="group" aria-label={`Filter group ${path}`}>
    <label className="group-conjunction">Match<select aria-label={`Match group ${path}`} value={group.conjunction}
      onChange={event => onChange({ ...group, conjunction: event.target.value as 'and' | 'or' })}>
      <option value="and">all conditions (AND)</option><option value="or">any condition (OR)</option>
    </select></label>
    {!group.conditions.length && <p className="form-note">No conditions: {group.conjunction === 'and' ? 'matches every record' : 'matches no records'}.</p>}
    {group.conditions.map((condition, index) => <div className="filter-entry" key={index}>
      {'conjunction' in condition ? <FilterGroupEditor fields={fields} group={condition} onChange={value => replace(index, value)} remaining={remaining} depth={depth + 1} path={`${path}.${index + 1}`} />
        : <FilterRule fields={fields} rule={condition} onChange={value => replace(index, value)} path={`${path}.${index + 1}`} />}
      <button type="button" className="remove-filter" aria-label={`Remove filter ${path}.${index + 1}`}
        onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })}>Remove</button>
    </div>)}
    <div className="filter-actions"><button type="button" disabled={remaining <= 0} aria-label={`Add condition to group ${path}`}
      onClick={() => onChange({ ...group, conditions: [...group.conditions, { fieldId: fields[0]!.id, operator: 'isNotEmpty', value: null }] })}>Add condition</button>
      <button type="button" disabled={remaining <= 0 || depth >= 4} aria-label={`Add subgroup to group ${path}`}
        onClick={() => onChange({ ...group, conditions: [...group.conditions, { conjunction: 'and', conditions: [] }] })}>Add group</button></div>
  </div>;
}

function FilterRule({ fields, rule, onChange, path }: { fields: Field[]; rule: RuleDraft; onChange(rule: RuleDraft): void; path: string }) {
  const field = fields.find(field => field.id === rule.fieldId)!;
  const operators = filterOperators(field);
  const empty = rule.operator === 'isEmpty' || rule.operator === 'isNotEmpty';
  const ordered = ['gt', 'gte', 'lt', 'lte'].includes(rule.operator);
  const nullOnly = field.type === 'multiSelect' && (rule.operator === 'eq' || rule.operator === 'neq');
  return <div className="filter-rule" role="group" aria-label={`Filter ${path}`}>
    <select aria-label="Filter field" value={field.id} onChange={event => onChange({ fieldId: event.target.value, operator: 'isNotEmpty', value: null })}>
      {fields.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select>
    <select aria-label="Filter operator" value={rule.operator} onChange={event => {
      const operator = event.target.value as FilterOperator;
      const value = operator === 'hasAny' ? Array.isArray(rule.value) ? rule.value : []
        : field.type === 'multiSelect' ? null : operator === 'contains' ? rule.value ?? '' : rule.value;
      onChange({ ...rule, operator, value });
    }}>{operators.map(operator => <option value={operator} key={operator}>{field.type === 'multiSelect' && (operator === 'eq' || operator === 'neq')
      ? operator === 'eq' ? 'is not set (null)' : 'is set (not null)' : operatorNames[operator]}</option>)}</select>
    {!empty && !nullOnly && <FieldInput field={{ ...field, name: 'Value', required: ordered }} value={rule.value} onChange={value => onChange({ ...rule, value })} />}
  </div>;
}
