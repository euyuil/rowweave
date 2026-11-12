import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClipboard, serializeClipboard } from '../src/clipboard.js';

test('copied TSV round trips literal text, multiline cells and blank columns', () => {
  const rows = [['中文🌱', '第一行\n第二行', 'quoted "value"'], ['<b>literal & text</b>', '\t\r\n', ''], ['', '', '']];
  assert.deepEqual(parseClipboard(serializeClipboard(rows)), rows);
  assert.equal(serializeClipboard([['a\rb', '"quote"']]), '"a\rb"\t"""quote"""');
  assert.deepEqual(parseClipboard(serializeClipboard([['value'], [''], ['']])), [['value'], [''], ['']]);
});

test('clipboard preserves Unicode, quoted delimiters, multiline values and trailing empty cells', () => {
  assert.deepEqual(parseClipboard('中文 🌱\t第二列\r\n"a\tb\n""quoted"""\t\r\n'),
    [['中文 🌱', '第二列'], ['a\tb\n"quoted"', '']]);
  assert.deepEqual(parseClipboard(''), [['']]);
  assert.deepEqual(parseClipboard('\t'), [['', '']]);
  assert.deepEqual(parseClipboard('a\tb\n\n'), [['a', 'b'], ['']]);
  assert.deepEqual(parseClipboard('a"b\t""'), [['a"b', '']]);
  const cells = Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => `Paste ${row}/${col} 🌱`));
  assert.deepEqual(parseClipboard(cells.map(row => row.join('\t')).join('\n')), cells);
});

test('clipboard rejects malformed quotes and oversized batches before staging edits', () => {
  for (const input of ['"unfinished', '"closed"suffix', 'x'.repeat(10_001),
    Array(2_002).fill('x').join('\n'), Array(20_002).fill('x').join('\t')]) {
    assert.throws(() => parseClipboard(input));
  }
});
