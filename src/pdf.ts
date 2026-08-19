import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 常见 Edge 安装路径（Windows 10/11 自带） */
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * 用 Edge 无头模式把 HTML 日报打印成 PDF（尽力而为，找不到 Edge 则跳过）。
 * 页面已有 @media print 样式：工具栏/按钮自动隐藏。
 */
export function tryPrintPdf(htmlFile: string): string | null {
  const exe = EDGE_PATHS.find((p) => existsSync(p));
  if (!exe) {
    console.log('[pdf] 未找到 Microsoft Edge，跳过 PDF 导出');
    return null;
  }
  const pdfFile = htmlFile.replace(/\.html$/, '.pdf');
  try {
    const res = spawnSync(
      exe,
      [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        '--virtual-time-budget=8000',
        `--print-to-pdf=${pdfFile}`,
        pathToFileURL(htmlFile).href,
      ],
      { timeout: 60_000, windowsHide: true },
    );
    if (res.status === 0 && existsSync(pdfFile)) {
      console.log(`[pdf] 已导出 ${pdfFile}`);
      return pdfFile;
    }
    console.log('[pdf] 打印失败，跳过');
    return null;
  } catch {
    console.log('[pdf] 打印异常，跳过');
    return null;
  }
}
