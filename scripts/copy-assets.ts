import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../../public/', import.meta.url);
const output = new URL('../public/', import.meta.url);
export function copyAssets(): void {
  mkdirSync(fileURLToPath(output), { recursive: true });
  for (const name of ['index.html', 'style.css']) copyFileSync(new URL(name, source), new URL(name, output));
}
copyAssets();
