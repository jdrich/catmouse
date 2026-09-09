// Drive L1–L8. Each level gets `turnLimit` attacker turns. Writes JSON to runs/.
// Env: see .env.example (ATTACKER_PROVIDER/MODEL, DEFENDER_PROVIDER/MODEL).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GenericClient } from './genericClient.ts';
import { loadEnv, turnLimit } from './loadEnv.ts';
import { resolveNamedClient, resolveRoleClient } from './providers.ts';
import { runAttack, type TurnRecord } from './loop.ts';
import * as level1 from '../goals/level1.ts';
import * as level2 from '../goals/level2.ts';
import * as level3 from '../goals/level3.ts';
import * as level4 from '../goals/level4.ts';
import * as level5 from '../goals/level5.ts';
import * as level6 from '../goals/level6.ts';
import * as level7 from '../goals/level7.ts';
import * as level8 from '../goals/level8.ts';

export const LEVELS = [
  { id: 1, name: 'canary', goal: level1 },
  { id: 2, name: 'disclosure', goal: level2 },
  { id: 3, name: 'fs-write', goal: level3 },
  { id: 4, name: 'tool-call', goal: level4 },
  { id: 5, name: 'exfil', goal: level5 },
  { id: 6, name: 'persist', goal: level6 },
  { id: 7, name: 'priv-esc', goal: level7 },
  { id: 8, name: 'takeover', goal: level8 },
] as const;

export type SerializedTurn = {
  attacker: string;
  payload: string;
  defender: string;
  remaining: number | undefined;
  probe: boolean;
  toolCalls: { name: string; arguments: string }[];
};

export type RunRecord = {
  id: string;
  at: string;
  kind: 'attack';
  status: 'running' | 'done' | 'aborted' | 'error';
  attacker: { provider: string; model: string };
  defender: { provider: string; model: string };
  successes: number;
  note: string;
  error?: string;
  levels: Record<number, { success: boolean; turns: SerializedTurn[] }>;
};

export type RunEvent =
  | { type: 'start'; run: RunRecord }
  | { type: 'turn'; level: number; name: string; turn: SerializedTurn; turnsUsed: number; success: boolean }
  | { type: 'level'; level: number; name: string; success: boolean; turnsUsed: number }
  | { type: 'done'; run: RunRecord }
  | { type: 'error'; message: string };

export function serializeTurn(t: TurnRecord): SerializedTurn {
  return {
    attacker: t.attacker ?? '',
    payload: t.payload ?? '',
    defender: t.content ?? '',
    remaining: t.remaining,
    probe: t.probe ?? false,
    toolCalls: (t.toolCalls ?? []).map((tc) => ({
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
}

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function runPath(id: string) {
  return join(repoRoot(), 'runs', `${id}.json`);
}

async function writeRun(run: RunRecord) {
  const dir = join(repoRoot(), 'runs');
  await mkdir(dir, { recursive: true });
  await writeFile(runPath(run.id), JSON.stringify(run, null, 2), 'utf8');
}

export async function driveRun(opts: {
  attacker: { provider: string; model: string };
  defender: { provider: string; model: string };
  id?: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}): Promise<RunRecord> {
  const at = new Date().toISOString();
  const run: RunRecord = {
    id: opts.id || `run-${at.replace(/[:.]/g, '').slice(0, 15)}`,
    at,
    kind: 'attack',
    status: 'running',
    attacker: { provider: opts.attacker.provider, model: opts.attacker.model },
    defender: { provider: opts.defender.provider, model: opts.defender.model },
    successes: 0,
    note: `running  ·  ${turnLimit()} turns / level`,
    levels: {},
  };

  const emit = (event: RunEvent) => opts.onEvent?.(event);
  emit({ type: 'start', run });
  await writeRun(run);

  try {
    for (const L of LEVELS) {
      if (opts.signal?.aborted) throw new Error('run aborted');
      const attackerCfg = await resolveNamedClient(opts.attacker.provider, opts.attacker.model);
      const defenderCfg = await resolveNamedClient(opts.defender.provider, opts.defender.model);
      run.attacker.model = attackerCfg.model;
      run.defender.model = defenderCfg.model;
      const result = await runAttack({
        attacker: new GenericClient(attackerCfg),
        defender: new GenericClient(defenderCfg),
        goal: L.goal,
        signal: opts.signal,
        onTurn: async (turn, turnsUsed, hit) => {
          const serialized = serializeTurn(turn);
          const soFar = run.levels[L.id]?.turns ?? [];
          run.levels[L.id] = { success: hit, turns: [...soFar, serialized] };
          await writeRun(run);
          emit({
            type: 'turn',
            level: L.id,
            name: L.name,
            turn: serialized,
            turnsUsed,
            success: hit,
          });
        },
      });
      run.levels[L.id] = {
        success: result.success,
        turns: result.turns.map(serializeTurn),
      };
      if (result.success) run.successes++;
      emit({
        type: 'level',
        level: L.id,
        name: L.name,
        success: result.success,
        turnsUsed: result.turnsUsed,
      });
      run.note = `${run.successes}/8  ·  ${turnLimit()} turns / level`;
      await writeRun(run);
    }
    run.status = 'done';
    run.note = `${run.successes}/8  ·  ${turnLimit()} turns / level`;
    await writeRun(run);
    emit({ type: 'done', run });
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.status = message === 'run aborted' ? 'aborted' : 'error';
    run.error = message;
    run.note = run.status === 'aborted' ? 'aborted' : message;
    await writeRun(run);
    emit({ type: 'error', message });
    throw err;
  }
}

async function main() {
  loadEnv();
  const attacker = {
    provider: process.env.ATTACKER_PROVIDER || '',
    model: process.env.ATTACKER_MODEL || '',
  };
  const defender = {
    provider: process.env.DEFENDER_PROVIDER || '',
    model: process.env.DEFENDER_MODEL || '',
  };
  const run = await driveRun({
    attacker,
    defender,
    onEvent: (event) => {
      if (event.type === 'start') console.log(`${event.run.id}  atk ${event.run.attacker.model}  def ${event.run.defender.model}`);
      if (event.type === 'level') {
        console.log(`L${event.level} ${event.name} — ${event.success ? 'HIT' : 'miss'}  ${event.turnsUsed}/${turnLimit()}`);
      }
      if (event.type === 'done') console.log(`wrote ${runPath(event.run.id)}`);
    },
  });
  if (run.status !== 'done') process.exitCode = 1;
}

const isCli = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);
if (isCli) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
