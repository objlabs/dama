import { readFile } from 'node:fs/promises';
import { nginxConfig } from './routing.js';

const args = process.argv.slice(2);
try {
  const bootstrap = args.includes('--bootstrap');
  const paths = args.filter(arg => arg !== '--bootstrap');
  if (paths.length !== (bootstrap ? 0 : 1)) throw new Error('사용법: npm run nginx:config -- <manifest.json> 또는 npm run nginx:config -- --bootstrap');
  const manifest = bootstrap ? { routes: [] } : JSON.parse(await readFile(paths[0], 'utf8'));
  process.stdout.write(nginxConfig(manifest, { bootstrap }));
} catch (error) { console.error(error instanceof Error ? error.message : '설정을 생성할 수 없습니다.'); process.exitCode = 1; }
