/**
 * LLM 调用层（summarize 与 judge 共用）：
 * 供应商顺序故障转移 + 连续失败熔断 + response_format 运行时探测降级 + 调用明细落库。
 */
import OpenAI from 'openai';
import { SETTINGS, buildProviders } from './config.js';
import { logModelCall } from './db.js';

/** 一个模型候选（含本轮运行的健康状态与 JSON 模式探测结果） */
export interface RuntimeProvider {
  name: string;
  model: string;
  client: OpenAI;
  consecutiveFails: number;
  disabled: boolean;
  /** 探测到该供应商不支持 response_format json_object 后置 true，本轮后续调用不再携带 */
  noJsonMode: boolean;
}

export function initProviders(): RuntimeProvider[] {
  return buildProviders().map((p) => ({
    name: p.name,
    model: p.model,
    client: new OpenAI({
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      timeout: SETTINGS.apiTimeoutMs,
      maxRetries: 2, // SDK 内置重试：429 / 5xx / 网络错误
    }),
    consecutiveFails: 0,
    disabled: false,
    noJsonMode: false,
  }));
}

/** 每个供应商的用量累计：调用数 + token 明细（明细已落 model_calls，此处供控制台汇总） */
export interface UsageCount {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
export type UsageMap = Record<string, UsageCount>;

export interface CallChatOpts {
  providers: RuntimeProvider[];
  runId: number;
  purpose: 'summary' | 'judge';
  articleId?: number;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** true：优先带 response_format json_object，探测到不支持时同供应商自动降级重发 */
  jsonMode: boolean;
  /** 可选：就地累计用量（成功调用） */
  usage?: UsageMap;
}

export interface CallChatResult {
  text: string;
  provider: RuntimeProvider;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** 判断错误是否为「不支持 response_format」（用于降级，不计熔断） */
function isJsonModeUnsupported(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  const msg = (e.message ?? '').toLowerCase();
  return (
    e.status === 400 &&
    (/response_format/.test(msg) ||
      /json_object/.test(msg) ||
      /json.?mode/.test(msg) ||
      /invalid parameter/.test(msg) ||
      /not support/.test(msg))
  );
}

/**
 * 按候选顺序调用模型，返回首个成功结果；全部失败时抛错（message 为最后一次错误）。
 * 每次尝试（成功/失败/json 降级）都写入 model_calls。
 */
export async function callChat(opts: CallChatOpts): Promise<CallChatResult> {
  let lastErr = '';
  let attempt = 0;
  for (const p of opts.providers) {
    if (p.disabled) continue;
    // pass 0 = 带 json_object（若启用）；pass 1 = 同供应商降级重发（仅 json 不支持时）
    for (let pass = 0; pass < 2; pass++) {
      const useJson = opts.jsonMode && !p.noJsonMode && pass === 0;
      const t0 = Date.now();
      const attemptNo = ++attempt;
      try {
        const res = await p.client.chat.completions.create({
          model: p.model,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          ...(useJson ? { response_format: { type: 'json_object' as const } } : {}),
        });
        const text = res.choices[0]?.message?.content?.trim();
        if (!text) throw new Error('模型返回空内容');
        const promptTokens = res.usage?.prompt_tokens ?? 0;
        const completionTokens = res.usage?.completion_tokens ?? 0;
        const latencyMs = Date.now() - t0;
        logModelCall({
          runId: opts.runId,
          purpose: opts.purpose,
          provider: p.name,
          model: p.model,
          articleId: opts.articleId,
          attempt: attemptNo,
          ok: true,
          promptTokens,
          completionTokens,
          latencyMs,
        });
        p.consecutiveFails = 0;
        if (opts.usage) {
          const u = (opts.usage[p.name] ??= {
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
          });
          u.calls++;
          u.promptTokens += promptTokens;
          u.completionTokens += completionTokens;
        }
        return { text, provider: p, promptTokens, completionTokens, latencyMs };
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number }).status;
        logModelCall({
          runId: opts.runId,
          purpose: opts.purpose,
          provider: p.name,
          model: p.model,
          articleId: opts.articleId,
          attempt: attemptNo,
          ok: false,
          httpStatus: status,
          error: lastErr,
          latencyMs: Date.now() - t0,
        });
        // JSON 模式不被该供应商支持：标记后同供应商立即无参重发（不消耗熔断计数）
        if (useJson && isJsonModeUnsupported(err)) {
          p.noJsonMode = true;
          console.warn(
            `[llm] ${p.name} 不支持 response_format(json_object)，降级为纯文本输出 + 宽松提取`,
          );
          continue;
        }
        p.consecutiveFails++;
        console.warn(`[llm] ${p.name} 调用失败(${lastErr})，尝试下一候选`);
        if (p.consecutiveFails >= SETTINGS.providerFailsLimit && !p.disabled) {
          p.disabled = true;
          console.warn(`[llm] ${p.name} 连续失败 ${SETTINGS.providerFailsLimit} 次，本轮停用`);
        }
        break; // 换下一供应商
      }
    }
  }
  throw new Error(lastErr || '无可用模型');
}
