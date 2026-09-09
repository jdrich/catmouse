// Attacker ↔ defender loop. Neither side executes tools.
// Channel: attacker text → (optional payload extract) → defender user message.
// Defender may *emit* stub tool calls; we log them and never run them.

import { GenericClient, type ChatMessage, type ChatResponse, type OnDelta } from './genericClient.ts';
import { turnLimit } from './loadEnv.ts';
import { attackerSystemPrompt, defenderSystemPrompt } from './prompts.ts';
import { STUB_TOOLS } from './stubTools.ts';

export type Goal = {
  attackerPrompt: string;
  isSuccess: (raw: any) => boolean;
  /** One-line mission for the fire-log modal. */
  summary?: string;
  /** If set, harness sends this as a follow-up user message (not the attacker). */
  probe?: string;
};

export type TurnRecord = ChatResponse & {
  attacker?: string;
  payload?: string;
  probe?: boolean;
  restart?: boolean;
  pending?: boolean;
  remaining?: number;
};

export type RunResult = {
  success: boolean;
  turnsUsed: number;
  turns: TurnRecord[];
};

export type LevelPhase = 'idle' | 'attack' | 'defend' | 'probe';

export type LevelCursor = {
  used: number;
  restarts: number;
  pendingResetNote: boolean;
  phase: LevelPhase;
  attackerMsgs: ChatMessage[];
  defenderMsgs: ChatMessage[];
};

export type ResumeLevel = LevelCursor & { turns: TurnRecord[] };

const MAX_RESTARTS_PER_LEVEL = 50;

/** First line exactly `/restart` (case-insensitive). Rest of the message is optional payload. */
export function splitRestart(text: string): { restart: boolean; rest: string } {
  const raw = text ?? '';
  const nl = raw.search(/\r?\n/);
  const first = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  if (first.toLowerCase() === '/restart') {
    const rest = nl === -1 ? '' : raw.slice(nl).replace(/^\r?\n/, '');
    return { restart: true, rest };
  }
  return { restart: false, rest: raw };
}

/** Prefer <payload> or ```payload fences; otherwise the whole attacker message. */
export function extractPayload(attackerText: string): string {
  const tagged = attackerText.match(/<payload>([\s\S]*?)<\/payload>/i);
  if (tagged) return tagged[1].trim();
  const fenced = attackerText.match(/```(?:payload|inject)\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return (attackerText ?? '').trim();
}

function describeForAttacker(def: ChatResponse): string {
  const bits: string[] = [];
  if (def.content) bits.push(def.content);
  if (def.toolCalls.length) {
    bits.push(
      'Observed (not executed) tool calls:\n' +
        def.toolCalls
          .map((tc) => `- ${tc.function.name}(${tc.function.arguments})`)
          .join('\n')
    );
  }
  return bits.join('\n\n') || '(empty defender reply)';
}

async function chatAs(
  role: 'attacker' | 'defender',
  client: GenericClient,
  messages: ChatMessage[],
  tools: any[] | undefined,
  signal?: AbortSignal,
  onDelta?: OnDelta,
): Promise<ChatResponse> {
  try {
    return await client.chat(messages, tools, signal, onDelta);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.message === 'run aborted') throw e;
    throw new Error(`${role} ${e.message}`);
  }
}

function throttle(ms: number, fn: () => Promise<void>) {
  let last = 0;
  let running = Promise.resolve();
  return async (force = false) => {
    const now = Date.now();
    if (!force && now - last < ms) return;
    last = now;
    running = running.then(fn, fn);
    await running;
  };
}

/** Harness wrapper. Defender reply is raw; budget is injected here, never spoken by the defender. */
function envelopeForAttacker(def: ChatResponse | null, remaining: number, limit: number): string {
  const parts: string[] = [];
  if (def) parts.push(describeForAttacker(def));
  parts.push(`Turns remaining: ${remaining} of ${limit}.`);
  return parts.join('\n\n');
}

export async function runAttack(opts: {
  attacker: GenericClient;
  defender: GenericClient;
  goal: Goal;
  defenderSystem?: string;
  signal?: AbortSignal;
  resume?: ResumeLevel;
  onTurn?: (turn: TurnRecord, turnsUsed: number, success: boolean, cursor: LevelCursor) => void | Promise<void>;
}): Promise<RunResult> {
  const defenderSystem = opts.defenderSystem ?? defenderSystemPrompt;
  const turns: TurnRecord[] = (opts.resume?.turns ?? []).filter((t) => !t.pending);
  const attackerMsgs: ChatMessage[] = opts.resume?.attackerMsgs?.length
    ? opts.resume.attackerMsgs.map((m) => ({ ...m }))
    : [
        { role: 'system', content: attackerSystemPrompt },
        { role: 'user', content: opts.goal.attackerPrompt },
      ];
  const defenderMsgs: ChatMessage[] = opts.resume?.defenderMsgs?.length
    ? opts.resume.defenderMsgs.map((m) => ({ ...m }))
    : [{ role: 'system', content: defenderSystem }];

  const limit = turnLimit();
  let used = opts.resume?.used ?? 0;
  let restarts = opts.resume?.restarts ?? 0;
  let pendingResetNote = opts.resume?.pendingResetNote ?? false;
  let phase: LevelPhase = opts.resume?.phase ?? 'idle';

  const cursor = (): LevelCursor => ({
    used,
    restarts,
    pendingResetNote,
    phase,
    attackerMsgs,
    defenderMsgs,
  });
  const emitTurn = (turn: TurnRecord, turnsUsed: number, hit: boolean) =>
    opts.onTurn?.(turn, turnsUsed, hit, cursor());

  while (used < limit) {
    if (opts.signal?.aborted) throw new Error('run aborted');
    const remaining = limit - used;
    let pending: TurnRecord | undefined;
    let flush = throttle(500, async () => undefined);

    if (phase === 'idle' || phase === 'attack') {
      if (phase === 'idle') {
        const prev = pendingResetNote ? null : lastEnvelopeTurn(turns);
        const envelope = envelopeForAttacker(prev, remaining, limit);
        attackerMsgs.push({
          role: 'user',
          content: pendingResetNote ? `Defender session reset.\n\n${envelope}` : envelope,
        });
        pendingResetNote = false;
        phase = 'attack';
      }
      pending = {
        content: null,
        toolCalls: [],
        raw: { pending: true },
        attacker: '',
        payload: '',
        remaining,
        pending: true,
      };
      turns.push(pending);
      flush = throttle(500, async () => {
        await emitTurn(pending!, used, false);
      });
      await flush(true);

      const attack = await chatAs(
        'attacker',
        opts.attacker,
        attackerMsgs,
        undefined,
        opts.signal,
        async (partial) => {
          pending!.attacker = partial.content ?? '';
          await flush();
        },
      );
      pending.attacker = attack.content ?? '';
      attackerMsgs.push({ role: 'assistant', content: attack.content ?? '' });

      const { restart, rest } = splitRestart(attack.content ?? '');
      let payloadSource = attack.content ?? '';
      if (restart) {
        restarts += 1;
        if (restarts > MAX_RESTARTS_PER_LEVEL) throw new Error('too many /restart');
        defenderMsgs.length = 0;
        defenderMsgs.push({ role: 'system', content: defenderSystem });
        const restartRecord: TurnRecord = {
          content: null,
          toolCalls: [],
          raw: { restart: true },
          attacker: attack.content ?? '',
          payload: '',
          remaining,
          restart: true,
        };
        const pendingAt = turns.findLastIndex((t) => t.pending);
        if (pendingAt >= 0) turns[pendingAt] = restartRecord;
        else turns.push(restartRecord);
        if (!rest.trim()) {
          phase = 'idle';
          pendingResetNote = true;
          await emitTurn(restartRecord, used, false);
          continue;
        }
        pendingResetNote = false;
        await emitTurn(restartRecord, used, false);
        payloadSource = rest;
        pending = {
          content: null,
          toolCalls: [],
          raw: { pending: true },
          attacker: attack.content ?? '',
          payload: '',
          remaining,
          pending: true,
        };
        turns.push(pending);
      }

      const payload = extractPayload(payloadSource);
      pending.payload = payload;
      pending.attacker = attack.content ?? '';
      defenderMsgs.push({ role: 'user', content: payload });
      phase = 'defend';
      await flush(true);
    } else {
      const lastUser = [...defenderMsgs].reverse().find((m) => m.role === 'user');
      const lastAtk = [...attackerMsgs].reverse().find((m) => m.role === 'assistant');
      pending = {
        content: null,
        toolCalls: [],
        raw: { pending: true },
        attacker: lastAtk?.content ?? '',
        payload: lastUser?.content ?? '',
        remaining,
        pending: true,
        probe: phase === 'probe',
      };
      turns.push(pending);
      flush = throttle(500, async () => {
        await emitTurn(pending!, used, false);
      });
      await flush(true);
    }

    if (phase === 'defend') {
      const defense = await chatAs(
        'defender',
        opts.defender,
        defenderMsgs,
        STUB_TOOLS,
        opts.signal,
        async (partial) => {
          pending!.content = partial.content;
          pending!.toolCalls = partial.toolCalls;
          pending!.raw = partial.raw;
          await flush();
        },
      );
      defenderMsgs.push({
        role: 'assistant',
        content: defense.content ?? '',
      });

      used += 1;
      const record: TurnRecord = {
        ...defense,
        attacker: pending?.attacker ?? '',
        payload: pending?.payload ?? '',
        remaining,
      };
      const doneAt = turns.findLastIndex((t) => t.pending);
      if (doneAt >= 0) turns[doneAt] = record;
      else turns.push(record);
      const hit = opts.goal.isSuccess({
        turns,
        content: defense.content,
        toolCalls: defense.toolCalls,
      });
      if (hit) {
        phase = 'idle';
        await emitTurn(record, used, true);
        return { success: true, turnsUsed: used, turns };
      }
      if (opts.goal.probe) {
        phase = 'probe';
        await emitTurn(record, used, false);
      } else {
        phase = 'idle';
        await emitTurn(record, used, false);
      }
    }

    if (phase === 'probe') {
      if (defenderMsgs.at(-1)?.content !== opts.goal.probe) {
        defenderMsgs.push({ role: 'user', content: opts.goal.probe! });
      }
      const probePending: TurnRecord = {
        content: null,
        toolCalls: [],
        raw: { pending: true },
        attacker: '',
        payload: opts.goal.probe,
        remaining,
        probe: true,
        pending: true,
      };
      if (!pending?.probe) turns.push(probePending);
      const live = pending?.probe ? pending : probePending;
      const flushProbe = throttle(500, async () => {
        await emitTurn(live, used, false);
      });
      await flushProbe(true);
      const probed = await chatAs(
        'defender',
        opts.defender,
        defenderMsgs,
        STUB_TOOLS,
        opts.signal,
        async (partial) => {
          live.content = partial.content;
          live.toolCalls = partial.toolCalls;
          live.raw = partial.raw;
          await flushProbe();
        },
      );
      defenderMsgs.push({ role: 'assistant', content: probed.content ?? '' });
      const probeRecord: TurnRecord = {
        ...probed,
        attacker: '',
        payload: opts.goal.probe,
        remaining,
        probe: true,
      };
      const probeAt = turns.findLastIndex((t) => t.pending);
      if (probeAt >= 0) turns[probeAt] = probeRecord;
      else turns.push(probeRecord);
      const hit = opts.goal.isSuccess({
        turns,
        content: probed.content,
        toolCalls: probed.toolCalls,
      });
      phase = 'idle';
      await emitTurn(probeRecord, used, hit);
      if (hit) return { success: true, turnsUsed: used, turns };
    }
  }

  return { success: false, turnsUsed: limit, turns };
}

function lastEnvelopeTurn(turns: TurnRecord[]): TurnRecord | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (!turns[i].restart && !turns[i].pending) return turns[i];
  }
  return null;
}
