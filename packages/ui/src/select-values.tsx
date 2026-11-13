import React from 'react';
import { GridCellKind, type DrawCellCallback } from '@glideapps/glide-data-grid';
import type { SelectOption } from '../../contracts/src/index.js';
import type { EditableCell } from './cell-editor.js';
import { selectedOptions, selectStyle } from './select-colors.js';

export function SelectValues({ options }: { options: SelectOption[] }) {
  return <span className="select-values">{options.map((option, index) => <span className="select-value" key={`${option.id}:${index}`} style={selectStyle(option)}>{option.name}</span>)}</span>;
}

export const drawSelectCell: DrawCellCallback = (args, drawContent) => {
  if (args.cell.kind !== GridCellKind.Text || !('field' in args.cell)) { drawContent(); return; }
  const cell = args.cell as EditableCell, options = selectedOptions(cell.field, cell.rawValue);
  if (!options) { drawContent(); return; }
  const { ctx, rect, theme } = args;
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2); ctx.clip();
  ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';
  const height = Math.min(22, rect.height - 6), top = rect.y + (rect.height - height) / 2;
  const right = rect.x + rect.width - theme.cellHorizontalPadding;
  let left = rect.x + theme.cellHorizontalPadding;
  for (const option of options) {
    if (right - left < 20) break;
    const width = Math.min(ctx.measureText(option.name).width + 16, right - left), style = selectStyle(option);
    ctx.fillStyle = style.backgroundColor; ctx.beginPath(); ctx.roundRect(left, top, width, height, 5); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.rect(left + 6, top, width - 12, height); ctx.clip();
    ctx.fillStyle = style.color; ctx.fillText(option.name, left + 8, rect.y + rect.height / 2); ctx.restore();
    left += width + 5;
  }
  ctx.restore();
};
