import { valueField, type Field, type GroupCollapse } from '../../contracts/src/index.js';
import { parseGroupCollapse } from '../../core/src/record-groups.js';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface GroupPreference { choice: GroupCollapse; error?: string }
const storageKey = (namespace: string) => 'rowweave.groups.' + namespace;

export function readGroupPreference(namespace: string, field: Field, storage: PreferenceStorage): GroupPreference {
  try {
    const saved = storage.getItem(storageKey(namespace));
    if (saved === null) return { choice: { defaultCollapsed: false, exceptions: [] } };
    let value: unknown = JSON.parse(saved);
    const selected = valueField(field);
    if (selected.type === 'singleSelect' && value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>, options = new Set(selected.options!.map(option => option.id));
      if (Array.isArray(input['exceptions'])) value = { ...input,
        exceptions: input['exceptions'].filter(key => typeof key !== 'string' || options.has(key)) };
    }
    return { choice: parseGroupCollapse(field, value) };
  } catch (failure) {
    return { choice: { defaultCollapsed: false, exceptions: [] },
      error: 'Could not load saved group choices. Groups start expanded. ' +
        (failure instanceof Error ? failure.message : 'Storage is unavailable.') };
  }
}

export function writeGroupPreference(namespace: string, choice: GroupCollapse, storage: PreferenceStorage): GroupPreference {
  try { storage.setItem(storageKey(namespace), JSON.stringify(choice)); return { choice }; }
  catch (failure) {
    return { choice, error: 'Could not remember group choices. The current layout is still usable. ' +
      (failure instanceof Error ? failure.message : 'Storage is unavailable.') };
  }
}
