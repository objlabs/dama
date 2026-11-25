import { readFile } from 'node:fs/promises';
import { nginxConfig } from './routing.js';

const args = process.argv.slice(2);
try {
  const bootstrap = args.includes('--bootstrap');
  const domainIndex = args.indexOf('--domain');
  const domain = domainIndex < 0 ? undefined : args[domainIndex + 1];
  const paths = args.filter((arg, index) => arg !== '--bootstrap' && (domainIndex < 0 || (index !== domainIndex && index !== domainIndex + 1)));
  if ((domainIndex >= 0 && !domain) || paths.length !== (bootstrap ? 0 : 1)) {
    throw new Error('사용법: npm run nginx:config -- <manifest.json> [--domain apps.example.com] 또는 --bootstrap --domain apps.example.com');
  }
  const manifest = bootstrap ? { routes: [] } : JSON.parse(await readFile(paths[0], 'utf8'));
  process.stdout.write(nginxConfig(domain === undefined ? manifest : { ...manifest, domain }, { bootstrap }));
} catch (error) { console.error(error instanceof Error ? error.message : '설정을 생성할 수 없습니다.'); process.exitCode = 1; }
