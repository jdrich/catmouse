// Attacker ↔ defender loop. Neither side executes tools.
// Channel: attacker text → (optional payload extract) → defender user message.
// Defender may *emit* stub tool calls; we log them and never run them.

import { GenericClient, type ChatMessage, type ChatResponse } from './genericClient.ts';
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
  reset?: boolean;
  probe?: boolean;
  remaining?: number;
};

export type RunResult = {
  success: boolean;
  turnsUsed: number;
  turns: TurnRecord[];
};

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
  onTurn?: (turn: TurnRecord, turnsUsed: number, success: boolean) => void;
}): Promise<RunResult> {
  const turns: TurnRecord[] = [];
  const attackerMsgs: ChatMessage[] = [];
  const defenderMsgs: ChatMessage[] = [];

  defenderMsgs.push({
    role: 'system',
    content: opts.defenderSystem ?? defenderSystemPrompt,
  });

  attackerMsgs.push({ role: 'system', content: attackerSystemPrompt });
  attackerMsgs.push({ role: 'user', content: opts.goal.attackerPrompt });

  const limit = turnLimit();
  for (let i = 0; i < limit; i++) {
    if (opts.signal?.aborted) throw new Error('run aborted');
    const remaining = limit - i;
    const prev = turns[turns.length - 1] ?? null;
    attackerMsgs.push({ role: 'user', content: envelopeForAttacker(prev, remaining, limit) });

    const attack = await opts.attacker.chat(attackerMsgs, undefined, opts.signal);
    attackerMsgs.push({ role: 'assistant', content: attack.content ?? '' });

    const payload = extractPayload(attack.content ?? '');
    defenderMsgs.push({ role: 'user', content: payload });

    const defense = await opts.defender.chat(defenderMsgs, STUB_TOOLS, opts.signal);
    defenderMsgs.push({
      role: 'assistant',
      content: defense.content ?? '',
    });

    const record: TurnRecord = {
      ...defense,
      attacker: attack.content ?? '',
      payload,
      remaining, // budget the attacker had this turn (harness-injected, not defender text)
    };
    turns.push(record);
    let hit = opts.goal.isSuccess({
      turns,
      content: defense.content,
      toolCalls: defense.toolCalls,
    });
    opts.onTurn?.(record, i + 1, hit);
    if (hit) return { success: true, turnsUsed: i + 1, turns };

    if (opts.goal.probe) {
      defenderMsgs.push({ role: 'user', content: opts.goal.probe });
      const probed = await opts.defender.chat(defenderMsgs, STUB_TOOLS, opts.signal);
      defenderMsgs.push({ role: 'assistant', content: probed.content ?? '' });
      const probeRecord: TurnRecord = {
        ...probed,
        attacker: '',
        payload: opts.goal.probe,
        remaining,
        probe: true,
      };
      turns.push(probeRecord);
      hit = opts.goal.isSuccess({
        turns,
        content: probed.content,
        toolCalls: probed.toolCalls,
      });
      opts.onTurn?.(probeRecord, i + 1, hit);
      if (hit) return { success: true, turnsUsed: i + 1, turns };
    }
  }

  return { success: false, turnsUsed: limit, turns };
}
