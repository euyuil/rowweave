import { isLookupSummary, type CellValue, type Field, type SelectOption } from '../../contracts/src/index.js';

export function selectStyle(option: Pick<SelectOption, 'color'>): { backgroundColor: string; color: string } {
  const backgroundColor = option.color ?? '#e7edf8';
  const [red, green, blue] = [1, 3, 5].map(offset => {
    const value = parseInt(backgroundColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
  return { backgroundColor, color: (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff' };
}

export function selectedOptions(field: Field, value: CellValue | undefined): SelectOption[] | undefined {
  if (isLookupSummary(field)) return undefined;
  const source = field.type === 'lookup' ? field.lookupResult! : field;
  if (source.type !== 'singleSelect' && source.type !== 'multiSelect') return undefined;
  const values = field.type === 'lookup' || source.type === 'multiSelect' ? (value ?? []) as CellValue[] : [value];
  return values.filter(value => value !== null && value !== undefined).map(id => source.options!.find(option => option.id === id)!);
}
