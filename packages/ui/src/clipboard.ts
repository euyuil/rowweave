import { maxBatchCells, maxBatchRecords, maxTextLength } from '../../contracts/src/index.js';

// Parse plain-text spreadsheet clipboard data without confusing code points and UTF-16 offsets.
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  let count = 0;
  const cell = () => {
    if (++count > maxBatchCells) throw new Error('Paste up to 20,000 cells at a time.');
    row.push(value);
    value = '';
    closedQuote = false;
  };
  const line = () => {
    if (rows.length >= maxBatchRecords) throw new Error('Paste up to 2,000 rows at a time.');
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else value += char;
    } else if (char === '\t') cell();
    else if (char === '\n' || char === '\r') {
      cell();
      line();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (char === '"' && value === '' && !closedQuote) quoted = true;
    else {
      if (closedQuote) throw new Error('The clipboard contains an invalid quoted cell.');
      value += char;
    }
    if (value.length > maxTextLength) throw new Error('Each pasted cell must contain at most 10,000 characters.');
  }
  if (quoted) throw new Error('The clipboard contains an unfinished quoted cell.');
  if (row.length || value.length || closedQuote || !rows.length) { cell(); line(); }
  return rows;
}
