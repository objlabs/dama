import type { DatabaseSync } from 'node:sqlite';
export const schemaVersion = 4;

export function migrateDatabase(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > schemaVersion) throw new Error('현재 앱보다 새로운 데이터베이스 버전입니다.');
    if (version < 2) db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('app','mcp')),
        language TEXT NOT NULL CHECK(language IN ('python','rust','typescript')),
        sourcePath TEXT NOT NULL, dockerfile TEXT NOT NULL, buildContext TEXT NOT NULL,
        containerPort INTEGER NOT NULL CHECK(containerPort BETWEEN 1 AND 65535),
        routeSegment TEXT NOT NULL, healthPath TEXT NOT NULL, watchPaths TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(projectId, name), UNIQUE(projectId, routeSegment)
      );
      ALTER TABLE mcps ADD COLUMN serviceId TEXT REFERENCES services(id) ON DELETE RESTRICT;
    `);
    if (version < 3) db.exec(`
      CREATE TABLE build_jobs (
        id TEXT PRIMARY KEY,
        serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        commitSha TEXT NOT NULL,
        source TEXT NOT NULL,
        build TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(serviceId, commitSha)
      );

    `);
    if (version < 4) db.exec(`
      ALTER TABLE build_jobs RENAME TO build_jobs_v3;
      CREATE TABLE build_jobs (
        id TEXT PRIMARY KEY,
        serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        commitSha TEXT NOT NULL,
        source TEXT NOT NULL,
        build TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        plan TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','deployed','failed')),
        error TEXT,
        release TEXT,
        active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
      );
      INSERT INTO build_jobs(id,serviceId,commitSha,source,build,createdAt)
        SELECT id,serviceId,commitSha,source,build,createdAt FROM build_jobs_v3 ORDER BY rowid;
      DROP TABLE build_jobs_v3;
      CREATE UNIQUE INDEX build_pending_commit ON build_jobs(serviceId,commitSha) WHERE status IN ('queued','running');
      CREATE UNIQUE INDEX build_single_runner ON build_jobs(status) WHERE status='running';
      CREATE UNIQUE INDEX build_active_service ON build_jobs(serviceId) WHERE active=1;
      PRAGMA user_version = ${schemaVersion};
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
