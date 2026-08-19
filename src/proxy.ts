import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** 若设置了 HTTPS_PROXY / HTTP_PROXY，让全局 fetch（含 openai SDK）都走代理 */
export function setupProxy(): void {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log(`[proxy] 已启用代理: ${proxy}`);
}
