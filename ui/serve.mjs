import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = dirname(fileURLToPath(import.meta.url));
const repo = join(ui, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(npx, ['--yes', 'tsx', 'ui/serve.ts'], {
  cwd: repo,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
