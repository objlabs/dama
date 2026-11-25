import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export function gitSecrets(databasePath: string) {
  const keyPath = `${databasePath}.git-key`;
  const memoryKey = databasePath === ':memory:' ? randomBytes(32) : undefined;

  function readKey(): Buffer {
    const file = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077))) {
        throw new Error('Git 인증 키 파일의 형식 또는 권한을 확인하세요.');
      }
      return readFileSync(file);
    } finally { closeSync(file); }
  }

  function key(create: boolean): Buffer {
    if (memoryKey) return memoryKey;
    try { return readKey(); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${keyPath}.${randomUUID()}`;
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try { linkSync(temporary, keyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    return readKey();
  }

  return {
    encrypt(token: string, scope: string, allowKeyCreation: boolean): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(allowKeyCreation), iv);
      cipher.setAAD(Buffer.from(scope));
      const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(value: string, scope: string): string {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key(false), data.subarray(0, 12));
      decipher.setAAD(Buffer.from(scope));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
