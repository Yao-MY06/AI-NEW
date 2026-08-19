const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  trade: '™',
  copy: '©',
  reg: '®',
  deg: '°',
  middot: '·',
};

function decodeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** 归一化链接用于去重与入库唯一键：去锚点/追踪参数，统一主机大小写与末尾斜杠 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    u.host = u.host.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

/** 去除 HTML 标签并解码实体（数字与常见命名实体；&amp; 最后解码以保证转义正确） */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => decodeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => decodeCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 简易并发池：limit 个 worker 依次领取任务，保持 results 顺序与 items 一致 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      // 索引已由长度检查保证有效（noUncheckedIndexedAccess 无法感知）
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
