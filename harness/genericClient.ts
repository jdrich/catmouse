// harness/genericClient.ts
// Thin, publishable model client. Zero pi dependency.
// Supports any OpenAI-compatible endpoint (OpenAI, Grok/xAI, local, etc.)

import { contextLimitTokens, modelTimeoutMs } from './loadEnv.ts';

export type ClientApi = 'chat' | 'responses';

export interface ClientConfig {
  apiKey: string;
  baseURL: string;        // e.g. https://api.openai.com/v1 or https://api.x.ai/v1
  model: string;
  /** chat/completions (default) or OpenAI-style /responses (Grok CLI proxy). */
  api?: ClientApi;
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  raw: any;
}

function textFromParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function responsesTools(tools: any[]): any[] {
  return tools.map((t) => {
    if (t?.type === 'function' && t.function) {
      return {
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      };
    }
    return t;
  });
}

function parseResponses(data: any): ChatResponse {
  const toolCalls: ToolCall[] = [];
  let content = typeof data?.output_text === 'string' ? data.output_text : '';
  for (const item of data?.output ?? []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const args = item.arguments;
      toolCalls.push({
        id: String(item.call_id || item.id || `call_${toolCalls.length}`),
        type: 'function',
        function: {
          name: String(item.name || ''),
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      });
      continue;
    }
    const chunk = textFromParts(item.content);
    if (chunk) content = content ? `${content}\n${chunk}` : chunk;
  }
  return { content: content || null, toolCalls, raw: data };
}

function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

/** Keep the system message, then newest messages, under the token cap. */
function clipToContextLimit<T extends { content?: string | null }>(
  messages: T[],
  limit: number,
): T[] {
  if (messages.length === 0) return messages;
  const head = messages[0];
  const tail = messages.slice(1);
  let used = estimateTokens(String(head.content ?? ''));
  const revived: T[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const cost = estimateTokens(String(tail[i].content ?? ''));
    if (used + cost > limit) break;
    used += cost;
    revived.push(tail[i]);
  }
  revived.reverse();
  return [head, ...revived];
}

function requestSignal(user?: AbortSignal): { signal: AbortSignal; timeoutMs: number } {
  const timeoutMs = modelTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    timeoutMs,
    signal: user ? AbortSignal.any([user, timeout]) : timeout,
  };
}

function throwFetch(err: unknown, signal: AbortSignal, timeoutMs: number): never {
  const reason = signal.reason as { name?: string } | undefined;
  if (reason?.name === 'TimeoutError' || (err instanceof DOMException && err.name === 'TimeoutError')) {
    throw new Error(`model timed out after ${timeoutMs}ms`);
  }
  if (signal.aborted) throw new Error('run aborted');
  throw err instanceof Error ? err : new Error(String(err));
}

export class GenericClient {
  constructor(private cfg: ClientConfig) {}

  async chat(messages: ChatMessage[], tools?: any[], signal?: AbortSignal): Promise<ChatResponse> {
    // Never execute tools. Attacker calls omit `tools`; defender may pass stub schemas.
    const useTools = tools ?? [];
    const clipped = clipToContextLimit(messages, contextLimitTokens());
    const base = this.cfg.baseURL.replace(/\/$/, '');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
      ...(this.cfg.headers ?? {}),
    };
    const req = requestSignal(signal);

    try {
      if (this.cfg.api === 'responses') {
        const instructions = clipped
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .filter(Boolean)
          .join('\n\n');
        const input = clipped
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            type: 'message',
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          }));
        const body: Record<string, unknown> = { model: this.cfg.model, input };
        if (instructions) body.instructions = instructions;
        if (useTools.length) {
          body.tools = responsesTools(useTools);
          body.tool_choice = 'auto';
        }
        const res = await fetch(`${base}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (!res.ok) throw new Error(`Model error ${res.status}: ${await res.text()}`);
        return parseResponses(await res.json());
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.cfg.model,
          messages: clipped,
          tools: useTools.length ? useTools : undefined,
          tool_choice: useTools.length ? 'auto' : undefined,
        }),
        signal: req.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Model error ${res.status}: ${err}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0]?.message;

      const toolCalls: ToolCall[] = (choice?.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));

      return {
        content: choice?.content ?? null,
        toolCalls,
        raw: data,
      };
    } catch (err) {
      throwFetch(err, req.signal, req.timeoutMs);
    }
  }
}

/** GET /models. OpenAI list shape `{ data: [{ id }] }`. */
export async function listModels(
  baseURL: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const req = requestSignal();
  let res: Response;
  try {
    res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, { headers, signal: req.signal });
  } catch (err) {
    throwFetch(err, req.signal, req.timeoutMs);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Models error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return rows.map((m: any) => String(m.id ?? m.name ?? '')).filter(Boolean).sort();
}

export function createAttackerClient(cfg: ClientConfig) {
  return new GenericClient(cfg);
}

export function createDefenderClient(cfg: ClientConfig) {
  return new GenericClient(cfg);
}
