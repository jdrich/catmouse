// harness/genericClient.ts
// Thin, publishable model client. Zero pi dependency.
// Supports any OpenAI-compatible endpoint (OpenAI, Grok/xAI, local, etc.)

import { contextLimitTokens, modelTimeoutMs } from './loadEnv.ts';

export type ClientApi = 'chat' | 'responses';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ClientConfig {
  apiKey: string;
  baseURL: string;        // e.g. https://api.openai.com/v1 or https://api.x.ai/v1
  model: string;
  /** chat/completions (default) or OpenAI-style /responses (Grok CLI proxy). */
  api?: ClientApi;
  headers?: Record<string, string>;
  /** Optional reasoning effort for models that support it (o1/o3, DeepSeek-R1, etc.). */
  reasoningEffort?: ReasoningEffort;
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

export type OnDelta = (partial: ChatResponse) => void | Promise<void>;

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

function parseChatJson(data: any): ChatResponse {
  const choice = data?.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (choice?.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
  return { content: choice?.content ?? null, toolCalls, raw: data };
}

function isSse(res: Response): boolean {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('event-stream');
}

async function readSse(
  res: Response,
  handle: (data: any, event: string) => void | Promise<void>,
  bump?: () => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty stream');
  const dec = new TextDecoder();
  let buf = '';
  let event = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) bump?.();
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) {
        event = '';
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') {
        if (raw === '[DONE]') return;
        continue;
      }
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      if (data?.error) {
        const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
        throw new Error(String(msg));
      }
      await handle(data, event);
    }
  }
}

type Acc = { content: string; tools: Map<string | number, ToolCall>; raw: any };

function snapshot(acc: Acc): ChatResponse {
  return {
    content: acc.content || null,
    toolCalls: [...acc.tools.values()],
    raw: acc.raw,
  };
}

function applyChatDelta(acc: Acc, data: any): void {
  acc.raw = data;
  const delta = data?.choices?.[0]?.delta;
  if (!delta) return;
  if (typeof delta.content === 'string') acc.content += delta.content;
  for (const tc of delta.tool_calls ?? []) {
    const i = typeof tc.index === 'number' ? tc.index : acc.tools.size;
    let cur = acc.tools.get(i);
    if (!cur) {
      cur = {
        id: String(tc.id || `call_${i}`),
        type: 'function',
        function: { name: '', arguments: '' },
      };
      acc.tools.set(i, cur);
    }
    if (tc.id) cur.id = String(tc.id);
    if (tc.function?.name) cur.function.name += tc.function.name;
    if (typeof tc.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
  }
}

function applyResponsesEvent(acc: Acc, data: any, event: string): void {
  acc.raw = data;
  const type = String(data?.type || event || '');
  if (type === 'response.completed' || type === 'response.done') {
    const parsed = parseResponses(data.response ?? data);
    if (parsed.content) acc.content = parsed.content;
    if (parsed.toolCalls.length) {
      acc.tools = new Map(parsed.toolCalls.map((tc, i) => [tc.id || i, tc]));
    }
    return;
  }
  const delta = data?.delta ?? data?.text;
  if (
    (type.includes('output_text') || type.includes('text.delta') || type === 'response.output_text.delta') &&
    typeof delta === 'string'
  ) {
    acc.content += delta;
  }
  const item = data?.item;
  if (item && (item.type === 'function_call' || item.type === 'tool_call')) {
    const id = String(item.call_id || item.id || `call_${acc.tools.size}`);
    const args = item.arguments;
    acc.tools.set(id, {
      id,
      type: 'function',
      function: {
        name: String(item.name || ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    });
  }
  if (type.includes('function_call_arguments') && typeof delta === 'string') {
    const id = data.item_id ?? data.output_index ?? [...acc.tools.keys()].at(-1);
    const cur = id != null ? acc.tools.get(id) : undefined;
    if (cur) cur.function.arguments += delta;
  }
}

async function finishChatStream(res: Response, onDelta?: OnDelta, bump?: () => void): Promise<ChatResponse> {
  const acc: Acc = { content: '', tools: new Map(), raw: null };
  await readSse(res, async (data) => {
    applyChatDelta(acc, data);
    await onDelta?.(snapshot(acc));
  }, bump);
  return snapshot(acc);
}

async function finishResponsesStream(res: Response, onDelta?: OnDelta, bump?: () => void): Promise<ChatResponse> {
  const acc: Acc = { content: '', tools: new Map(), raw: null };
  await readSse(res, async (data, event) => {
    applyResponsesEvent(acc, data, event);
    await onDelta?.(snapshot(acc));
  }, bump);
  return snapshot(acc);
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

function requestSignal(user?: AbortSignal): { signal: AbortSignal; timeoutMs: number; bump: () => void; clear: () => void } {
  const timeoutMs = modelTimeoutMs();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ctrl.abort(new DOMException(`model timed out after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);
  };
  arm();
  const clear = () => clearTimeout(timer);
  user?.addEventListener('abort', clear, { once: true });
  return {
    timeoutMs,
    bump: arm,
    clear,
    signal: user ? AbortSignal.any([user, ctrl.signal]) : ctrl.signal,
  };
}

function throwFetch(err: unknown, signal: AbortSignal, timeoutMs: number, model?: string): never {
  const reason = signal.reason as { name?: string } | undefined;
  const tag = model ? `${model}: ` : '';
  if (reason?.name === 'TimeoutError' || (err instanceof DOMException && err.name === 'TimeoutError')) {
    throw new Error(`${tag}model timed out after ${timeoutMs}ms`);
  }
  if (signal.aborted) throw new Error('run aborted');
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(msg.startsWith(tag) || !model ? msg : `${tag}${msg}`);
}

export class GenericClient {
  constructor(private cfg: ClientConfig) {}

  async chat(
    messages: ChatMessage[],
    tools?: any[],
    signal?: AbortSignal,
    onDelta?: OnDelta,
  ): Promise<ChatResponse> {
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
    const responses = this.cfg.api === 'responses';

    const bodyFor = (stream: boolean): Record<string, unknown> => {
      if (responses) {
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
        const body: Record<string, unknown> = { model: this.cfg.model, input, stream };
        if (instructions) body.instructions = instructions;
        if (useTools.length) {
          body.tools = responsesTools(useTools);
          body.tool_choice = 'auto';
        }
        return body;
      }
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: clipped,
        stream,
        tools: useTools.length ? useTools : undefined,
        tool_choice: useTools.length ? 'auto' : undefined,
      };
      if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
      return body;
    };

    const post = async (stream: boolean) =>
      fetch(`${base}/${responses ? 'responses' : 'chat/completions'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyFor(stream)),
        signal: req.signal,
      });

    try {
      let streamed = true;
      let res = await post(true);
      req.bump();
      if (!res.ok && (res.status === 400 || res.status === 422)) {
        await res.text().catch(() => '');
        streamed = false;
        res = await post(false);
        req.bump();
      }
      if (!res.ok) throw new Error(`Model error ${res.status}: ${await res.text()}`);

      if (streamed && isSse(res)) {
        return responses
          ? await finishResponsesStream(res, onDelta, req.bump)
          : await finishChatStream(res, onDelta, req.bump);
      }

      const data = await res.json();
      const parsed = responses ? parseResponses(data) : parseChatJson(data);
      await onDelta?.(parsed);
      return parsed;
    } catch (err) {
      throwFetch(err, req.signal, req.timeoutMs, this.cfg.model);
    } finally {
      req.clear();
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
  } finally {
    req.clear();
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Models error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return rows.map((m: any) => String(m.id ?? m.name ?? '')).filter(Boolean).sort();
}


