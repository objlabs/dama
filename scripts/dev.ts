import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { copyAssets } from './copy-assets.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
const commands = [
  [compiler, '--project', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
  [compiler, '--project', 'tsconfig.browser.json', '--watch', '--preserveWatchOutput'],
  ['--experimental-sqlite', '--watch', 'dist/src/server.js']
];
const children = commands.map(args => spawn(process.execPath, args, { cwd: root, stdio: 'inherit' }));
const assets = watch(new URL('../../public/', import.meta.url), (_event, filename) => {
  if (filename?.endsWith('.html') || filename?.endsWith('.css')) copyAssets();
});
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  assets.close();
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
