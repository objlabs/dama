import type { PortClass } from './types.js';
import { createServer } from 'node:net';

type PortGroup = PortClass | 'db';

export function hostPortRange(kind: PortGroup): readonly [number, number] {
  if (kind === 'db') return [5000, 5999];
  return kind === 'web' ? [3000, 3999] : [4000, 4999];
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve(true)));
  });
}

export async function allocateHostPort(
  kind: PortGroup,
  startContainer: (port: number) => Promise<boolean>,
  inUse: (port: number) => Promise<boolean> = async port => !await bindable(port)
): Promise<number> {
  const [minimum, maximum] = hostPortRange(kind);
  for (let port = maximum; port >= minimum; port--) {
    // The Docker bind is authoritative. A competing bind can occur after this host probe.
    if (!await inUse(port) && await startContainer(port)) return port;
  }
  throw new Error(`${minimum}–${maximum} 범위에 사용할 수 있는 호스트 포트가 없습니다.`);
}
