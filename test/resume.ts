#!/usr/bin/env tsx
import { canResume, publicRun, type RunRecord } from '../harness/run.ts';

function pass(name: string) {
  process.stdout.write(`✓ ${name}\n`);
}
function fail(name: string, got: unknown) {
  throw new Error(`✗ ${name}\n  got: ${JSON.stringify(got)}`);
}

function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass(name);
  else fail(name, got);
}

const base: RunRecord = {
  id: 'run-test',
  at: '2026-01-01T00:00:00.000Z',
  kind: 'attack',
  status: 'error',
  attacker: { provider: 'opencode', model: 'x' },
  defender: { provider: 'llama', model: 'y' },
  successes: 0,
  note: 'boom',
  levels: {},
};

eq('empty error is resumable', canResume(base), true);
eq('done is not', canResume({ ...base, status: 'done' }), false);
eq(
  'cursor mid-level',
  canResume({
    ...base,
    cursor: {
      level: 2,
      used: 3,
      restarts: 0,
      pendingResetNote: false,
      phase: 'defend',
      attackerMsgs: [{ role: 'system', content: 'a' }],
      defenderMsgs: [{ role: 'system', content: 'd' }],
    },
  }),
  true,
);
eq(
  'all levels present without cursor',
  canResume({
    ...base,
    levels: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, { success: false, turns: [] }])),
  }),
  false,
);

const stripped = publicRun({
  ...base,
  cursor: {
    level: 2,
    used: 3,
    restarts: 0,
    pendingResetNote: false,
    phase: 'attack',
    attackerMsgs: [{ role: 'user', content: 'secret' }],
    defenderMsgs: [{ role: 'assistant', content: 'nope' }],
  },
});
eq('public run drops msgs', Boolean((stripped.cursor as { attackerMsgs?: unknown }).attackerMsgs), false);
eq('public run keeps level', stripped.cursor?.level, 2);
