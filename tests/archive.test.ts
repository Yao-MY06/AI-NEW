/** jsonForScript：JSON 内联 <script> 的安全转义 */
import { describe, expect, it } from 'vitest';
import { jsonForScript } from '../src/archive.js';

describe('jsonForScript', () => {
  it('转义 </script> 防止逃逸', () => {
    const out = jsonForScript({ t: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script');
  });

  it('转义行分隔符 U+2028/U+2029', () => {
    const ls = String.fromCharCode(0x2028); // 行分隔符（对 JS 是换行，对 JSON 合法）
    const ps = String.fromCharCode(0x2029); // 段分隔符
    const out = jsonForScript(`a${ls}b${ps}c`);
    expect(out).not.toContain(ls);
    expect(out).not.toContain(ps);
    expect(out).toContain('\\u2028');
  });

  it('转义后仍是合法 JSON（可 round-trip）', () => {
    const data = [{ t: '</script>', zh: '标题' }];
    expect(JSON.parse(jsonForScript(data))).toEqual(data);
  });
});
