import { valueField, type Field, type GroupCollapse, type GroupPathCollapse } from '../../contracts/src/index.js';
import { parseGroupCollapse, parseGroupPaths } from '../../core/src/record-groups.js';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type GroupChoice = GroupCollapse | GroupPathCollapse;
export interface GroupPreference { choice: GroupChoice; error?: string }
const storageKey = (namespace: string) => 'rowweave.groups.' + namespace;

const removedOption = (field: Field, value: unknown) => {
  const selected = valueField(field);
  return selected.type === 'singleSelect' && typeof value === 'string' && !selected.options!.some(option => option.id === value);
};

export function pruneGroupChoice(fields: readonly Field[], choice: GroupChoice): GroupChoice {
  const exceptions = fields.length === 1 ? (choice as GroupCollapse).exceptions.filter(key => !removedOption(fields[0]!, key))
    : (choice as GroupPathCollapse).exceptions.filter(path => path.every((key, index) => !removedOption(fields[index]!, key)));
  return exceptions.length === choice.exceptions.length ? choice : { ...choice, exceptions } as GroupChoice;
}

export function readGroupPreference(namespace: string, field: Field | readonly Field[], storage: PreferenceStorage): GroupPreference {
  try {
    const saved = storage.getItem(storageKey(namespace));
    if (saved === null) return { choice: { defaultCollapsed: false, exceptions: [] } };
    let value: unknown = JSON.parse(saved);
    const fields = Array.isArray(field) ? field : [field as Field];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      if (Array.isArray(input['exceptions'])) value = { ...input,
        exceptions: input['exceptions'].filter(key => fields.length === 1 ? !removedOption(fields[0]!, key)
          : !Array.isArray(key) || !key.some((part, index) => fields[index] && removedOption(fields[index]!, part))) };
    }
    return { choice: fields.length === 1 ? parseGroupCollapse(fields[0]!, value) : parseGroupPaths(fields, value) };
  } catch (failure) {
    return { choice: { defaultCollapsed: false, exceptions: [] },
      error: 'Could not load saved group choices. Groups start expanded. ' +
        (failure instanceof Error ? failure.message : 'Storage is unavailable.') };
  }
}

export function writeGroupPreference(namespace: string, choice: GroupChoice, storage: PreferenceStorage): GroupPreference {
  try { storage.setItem(storageKey(namespace), JSON.stringify(choice)); return { choice }; }
  catch (failure) {
    return { choice, error: 'Could not remember group choices. The current layout is still usable. ' +
      (failure instanceof Error ? failure.message : 'Storage is unavailable.') };
  }
}
