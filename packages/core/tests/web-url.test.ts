import test from 'node:test';
import assert from 'node:assert/strict';
import { webUrl } from '../src/web-url.js';

test('web links accept explicit HTTP(S) addresses and reject unsafe or ambiguous input', () => {
  assert.equal(webUrl('https://example.com/path?q=1#part'), 'https://example.com/path?q=1#part');
  assert.equal(webUrl('HTTP://localhost:4317/a%20b'), 'http://localhost:4317/a%20b');
  assert.equal(webUrl('https://例子.测试/文档'), 'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E6%A1%A3');
  for (const input of [null, 1, {}, '', 'example.com', '//example.com', 'https:example.com', 'javascript:alert(1)',
    'file:///C:/test.exe', 'data:text/html,hello', 'ms-settings:', 'ftp://example.com', 'https://name:secret@example.com',
    'https://name@example.com', 'https://example.com/a b', 'https://example.com/\n', ' https://example.com',
    'https://\\example.com', 'http://', 'https://[invalid]', 'https://example.com/' + 'x'.repeat(2048),
    'https://example.com/' + '中'.repeat(300)]) assert.equal(webUrl(input), undefined, String(input));
});
