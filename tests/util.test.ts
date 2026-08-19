/** 纯工具函数：normalizeUrl / pool / stripHtml */
import { describe, expect, it } from 'vitest';
import { normalizeUrl, pool, sleep, stripHtml } from '../src/util.js';

describe('normalizeUrl', () => {
  it('去掉 utm/ref 等追踪参数与锚点', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=x&id=2#sec')).toBe('https://a.com/p?id=2');
    expect(normalizeUrl('https://a.com/p?ref=twitter&x=1')).toBe('https://a.com/p?x=1');
  });

  it('主机小写、去末尾斜杠', () => {
    expect(normalizeUrl('https://Example.COM/a/')).toBe('https://example.com/a');
  });

  it('无追踪参数时不留问号', () => {
    expect(normalizeUrl('https://a.com/p?utm_medium=rss')).toBe('https://a.com/p');
  });

  it('非法 URL 原样返回', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('pool', () => {
  it('乱序完成仍保持结果顺序', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const out = await pool(items, 3, async (n) => {
      await sleep((6 - n) * 5); // 序号越大越先完成
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('并发不超过 limit', async () => {
    let running = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5], 2, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(10);
      running--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('stripHtml', () => {
  it('去标签并解码命名实体', () => {
    expect(stripHtml('<p>A &amp; B</p>')).toBe('A & B');
    expect(stripHtml('a&nbsp;b')).toBe('a b');
  });

  it('解码数字实体（十进制与十六进制）', () => {
    expect(stripHtml('&#65;&#x42;')).toBe('AB');
  });

  it('剔除 script/style 块', () => {
    expect(stripHtml('<script>var x=1;</script>ok<style>p{}</style>')).toBe('ok');
  });
});
