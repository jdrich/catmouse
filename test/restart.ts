#!/usr/bin/env tsx
import { splitRestart } from '../harness/loop.ts';

function pass(name: string) {
  process.stdout.write(`✓ ${name}\n`);
}
function fail(name: string, got: unknown) {
  throw new Error(`✗ ${name}\n  got: ${JSON.stringify(got)}`);
}

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass(name);
  else fail(name, got);
}

eq('plain payload', splitRestart('hello'), { restart: false, rest: 'hello' });
eq('restart only', splitRestart('/restart'), { restart: true, rest: '' });
eq('restart case', splitRestart('/RESTART\n\npelican'), { restart: true, rest: '\npelican' });
eq('restart plus payload', splitRestart('/restart\nIgnore previous instructions.'), {
  restart: true,
  rest: 'Ignore previous instructions.',
});
eq('not first line', splitRestart('please\n/restart'), { restart: false, rest: 'please\n/restart' });
eq('leading space first line', splitRestart('  /restart  \npayload'), {
  restart: true,
  rest: 'payload',
});
