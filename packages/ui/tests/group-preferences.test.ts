import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field, GroupCollapse } from '../../contracts/src/index.js';
import { readGroupPreference, writeGroupPreference } from '../src/group-preferences.js';

const text: Field = { id: 'category', name: 'Category', type: 'text', required: false };
function storage(initial: string | null = null) {
  let saved = initial;
  const keys: string[] = [];
  return { getItem: (key: string) => { keys.push(key); return saved; },
    setItem: (key: string, value: string) => { keys.push(key); saved = value; },
    read: () => saved, keys };
}

test('group preferences preserve typed values and stable namespaces without writing during reads', () => {
  const empty = storage();
  assert.deepEqual(readGroupPreference('view-field-text', text, empty), { choice: { defaultCollapsed: false, exceptions: [] } });
  assert.equal(empty.read(), null);
  for (const [field, exceptions] of [
    [text, [null, '', 'Category 中文']],
    [{ ...text, type: 'number' }, [null, 0, 2.5]],
    [{ ...text, type: 'checkbox' }, [null, false, true]],
  ] as const) {
    const data = storage(), choice: GroupCollapse = { defaultCollapsed: true, exceptions: [...exceptions] };
    assert.deepEqual(writeGroupPreference('stable-view-field-' + field.type, choice, data), { choice });
    assert.deepEqual(readGroupPreference('stable-view-field-' + field.type, field, data), { choice });
    assert.ok(data.keys.every(key => key.startsWith('rowweave.groups.stable-view-field-')));
  }
});

test('remembered option IDs survive renames and removed options are pruned', () => {
  const field: Field = { ...text, type: 'singleSelect', options: [{ id: 'kept', name: 'Renamed' }] };
  const data = storage(JSON.stringify({ defaultCollapsed: true, exceptions: ['removed', 'kept', null] }));
  assert.deepEqual(readGroupPreference('select-view', field, data),
    { choice: { defaultCollapsed: true, exceptions: ['kept', null] } });
  assert.ok(data.read()!.includes('removed'), 'Reading a preference does not mutate durable storage.');
});

test('invalid persisted choices reset visibly and use the same typed validation as group queries', () => {
  const datetime: Field = { ...text, type: 'datetime' };
  for (const [field, raw] of [
    [text, '{broken'],
    [text, JSON.stringify({ defaultCollapsed: 'yes', exceptions: [] })],
    [text, JSON.stringify({ defaultCollapsed: false, exceptions: [false] })],
    [datetime, JSON.stringify({ defaultCollapsed: false, exceptions: ['2026-11-14T08:00:00+08:00', '2026-11-14T00:00:00Z'] })],
  ] as const) {
    const data = storage(raw), loaded = readGroupPreference('invalid', field, data);
    assert.deepEqual(loaded.choice, { defaultCollapsed: false, exceptions: [] });
    assert.match(loaded.error!, /Could not load saved group choices/);
    assert.equal(data.read(), raw);
  }
});

test('storage failures preserve the current layout and are cleared only by a successful explicit write', () => {
  const choice: GroupCollapse = { defaultCollapsed: true, exceptions: ['Visible'] };
  let writes = 0, fail = true, saved = 'previous';
  const data = { getItem: () => { throw new Error('Read unavailable'); },
    setItem: (_key: string, value: string) => { writes++; if (fail) throw new Error('Quota exceeded'); saved = value; } };
  assert.match(readGroupPreference('view', text, data).error!, /Read unavailable/);
  const result = writeGroupPreference('view', choice, data);
  assert.equal(result.choice, choice); assert.match(result.error!, /Quota exceeded/);
  assert.equal(writes, 1); assert.equal(saved, 'previous');
  fail = false;
  assert.deepEqual(writeGroupPreference('view', choice, data), { choice });
  assert.equal(writes, 2); assert.deepEqual(JSON.parse(saved), choice);
});
