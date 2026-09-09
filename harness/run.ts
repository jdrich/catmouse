// Drive L1–L8. Each level gets `turnLimit` attacker turns. Writes JSON to runs/.
// Env: see .env.example (ATTACKER_PROVIDER/MODEL, DEFENDER_PROVIDER/MODEL).

import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GenericClient, type ReasoningEffort } from './genericClient.ts';
import { loadEnv, turnLimit } from './loadEnv.ts';
import { resolveNamedClient } from './providers.ts';
import { runAttack, type LevelCursor, type TurnRecord } from './loop.ts';
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
  restart: boolean;
  pending: boolean;
  toolCalls: { name: string; arguments: string }[];
};

export type RolePick = {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
};

export type RunCursor = LevelCursor & { level: number };

export type RunRecord = {
  id: string;
  at: string;
  kind: 'attack';
  status: 'running' | 'done' | 'aborted' | 'error';
  attacker: RolePick;
  defender: RolePick;
  successes: number;
  note: string;
  error?: string;
  levels: Record<number, { success: boolean; turns: SerializedTurn[] }>;
  cursor?: RunCursor;
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
    restart: t.restart ?? false,
    pending: t.pending ?? false,
    toolCalls: (t.toolCalls ?? []).map((tc) => ({
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
}

export function deserializeTurn(t: SerializedTurn): TurnRecord {
  return {
    content: t.defender,
    toolCalls: (t.toolCalls ?? []).map((tc, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })),
    raw: {},
    attacker: t.attacker,
    payload: t.payload,
    remaining: t.remaining,
    probe: t.probe,
    restart: t.restart,
    pending: t.pending,
  };
}

function attackerTurnsUsed(turns: SerializedTurn[] | undefined) {
  return (turns ?? []).filter((t) => !t.probe && !t.restart && !t.pending).length;
}

function levelFinalized(run: RunRecord, id: number) {
  if (run.cursor?.level === id) return false;
  const rec = run.levels[id];
  if (!rec) return false;
  if (rec.success) return true;
  if (rec.turns?.at(-1)?.pending) return false;
  return attackerTurnsUsed(rec.turns) >= turnLimit();
}

export function canResume(run: RunRecord) {
  if (run.status === 'done') return false;
  if (run.cursor) return true;
  return LEVELS.some((L) => !run.levels[L.id]);
}

export function publicRun(run: RunRecord): RunRecord {
  if (!run.cursor) return run;
  const { attackerMsgs, defenderMsgs, ...cursor } = run.cursor;
  return { ...run, cursor: cursor as RunCursor };
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await readFile(runPath(id), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
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
  const dest = runPath(run.id);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(run, null, 2), 'utf8');
  try {
    await copyFile(tmp, dest);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function driveRun(opts: {
  attacker?: RolePick;
  defender?: RolePick;
  resume?: RunRecord;
  id?: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}): Promise<RunRecord> {
  const at = new Date().toISOString();
  const prior = opts.resume;
  if (prior && !canResume(prior)) throw new Error('this run cannot be resumed');
  const attacker = prior?.attacker ?? opts.attacker;
  const defender = prior?.defender ?? opts.defender;
  if (!attacker?.provider || !attacker.model || !defender?.provider || !defender.model) {
    throw new Error('attacker and defender models are required');
  }
  const run: RunRecord = prior
    ? {
        ...prior,
        status: 'running',
        error: undefined,
        note: `resuming  ·  ${turnLimit()} turns / level`,
        levels: { ...prior.levels },
      }
    : {
        id: opts.id || `run-${at.replace(/[:.]/g, '').slice(0, 15)}`,
        at,
        kind: 'attack',
        status: 'running',
        attacker: {
          provider: attacker.provider,
          model: attacker.model,
          reasoningEffort: attacker.reasoningEffort,
        },
        defender: {
          provider: defender.provider,
          model: defender.model,
          reasoningEffort: defender.reasoningEffort,
        },
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
      if (levelFinalized(run, L.id)) continue;
      const live = run.cursor?.level === L.id ? run.cursor : undefined;
      if (!live && run.levels[L.id]) delete run.levels[L.id];
      const attackerCfg = await resolveNamedClient(attacker.provider, attacker.model);
      const defenderCfg = await resolveNamedClient(defender.provider, defender.model);
      if (attacker.reasoningEffort) attackerCfg.reasoningEffort = attacker.reasoningEffort;
      if (defender.reasoningEffort) defenderCfg.reasoningEffort = defender.reasoningEffort;
      run.attacker.model = attackerCfg.model;
      run.defender.model = defenderCfg.model;
      const result = await runAttack({
        attacker: new GenericClient(attackerCfg),
        defender: new GenericClient(defenderCfg),
        goal: L.goal,
        signal: opts.signal,
        resume: live
          ? {
              ...live,
              turns: (run.levels[L.id]?.turns ?? []).map(deserializeTurn),
            }
          : undefined,
        onTurn: async (turn, turnsUsed, hit, cursor) => {
          const serialized = serializeTurn(turn);
          const soFar = run.levels[L.id]?.turns ?? [];
          const turns = soFar.at(-1)?.pending
            ? [...soFar.slice(0, -1), serialized]
            : [...soFar, serialized];
          run.cursor = { level: L.id, ...cursor };
          run.levels[L.id] = { success: hit, turns };
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
      delete run.cursor;
      run.levels[L.id] = {
        success: result.success,
        turns: result.turns.map(serializeTurn),
      };
      run.successes = LEVELS.filter((row) => run.levels[row.id]?.success).length;
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
