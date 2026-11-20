import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CharacterProfile,
  MovieProject,
  ProcessingLogEntry,
  ProcessingStageName,
  StudioUser,
  UploadSession,
} from './types.ts';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
export const WORK_DIR = path.resolve(process.cwd(), 'work');
export const OUTPUTS_DIR = path.resolve(process.cwd(), 'outputs');

for (const dir of [DATA_DIR, UPLOADS_DIR, WORK_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'studio-db.json');

interface StudioDatabase {
  users: Record<string, StudioUser>;
  movies: Record<string, MovieProject>;
  uploadSessions: Record<string, UploadSession>;
}

function loadDatabase(): StudioDatabase {
  if (!fs.existsSync(DB_PATH)) {
    return { users: {}, movies: {}, uploadSessions: {} };
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StudioDatabase>;
    return {
      users: parsed.users ?? {},
      movies: parsed.movies ?? {},
      uploadSessions: parsed.uploadSessions ?? {},
    };
  } catch {
    return { users: {}, movies: {}, uploadSessions: {} };
  }
}

let db: StudioDatabase = loadDatabase();
let writeQueue: Promise<void> = Promise.resolve();

function persistSyncSafe(): void {
  const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

export function saveDatabase(): Promise<void> {
  writeQueue = writeQueue.then(() => {
    persistSyncSafe();
  });
  return writeQueue;
}

export function upsertUser(user: StudioUser): StudioUser {
  const existing = db.users[user.uid];
  if (existing) {
    db.users[user.uid] = {
      ...existing,
      email: user.email || existing.email,
      displayName: user.displayName || existing.displayName,
    };
  } else {
    db.users[user.uid] = user;
  }
  persistSyncSafe();
  return db.users[user.uid];
}

export function getUser(uid: string): StudioUser | undefined {
  return db.users[uid];
}

export function markUserShortClipVerified(uid: string): void {
  if (db.users[uid]) {
    db.users[uid].shortClipVerified = true;
    persistSyncSafe();
  }
}

export function createMovie(movie: MovieProject): MovieProject {
  db.movies[movie.id] = movie;
  persistSyncSafe();
  return movie;
}

export function getMovie(id: string): MovieProject | undefined {
  return db.movies[id];
}

export function listMoviesByOwner(ownerId: string): MovieProject[] {
  return Object.values(db.movies)
    .filter((m) => m.ownerId === ownerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function listRecoverableMovies(): MovieProject[] {
  return Object.values(db.movies).filter(
    (m) => m.status === 'processing' || m.status === 'queued' || m.status === 'scanning'
  );
}

export function updateMovie(id: string, patch: Partial<MovieProject>): MovieProject | undefined {
  const existing = db.movies[id];
  if (!existing) return undefined;
  db.movies[id] = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  persistSyncSafe();
  return db.movies[id];
}

export function appendMovieLog(
  id: string,
  stage: ProcessingStageName | 'System',
  level: ProcessingLogEntry['level'],
  message: string
): void {
  const movie = db.movies[id];
  if (!movie) return;
  const entry: ProcessingLogEntry = {
    id: crypto.randomUUID(),
    stage,
    level,
    message: message.slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  const nextLogs = [...movie.logs, entry];
  // Keep latest 400 log lines to prevent unbounded document bloat
  movie.logs = nextLogs.length > 400 ? nextLogs.slice(-400) : nextLogs;
  movie.updatedAt = new Date().toISOString();
  persistSyncSafe();
}

export function updateMovieCharacters(
  id: string,
  characters: CharacterProfile[]
): MovieProject | undefined {
  const movie = db.movies[id];
  if (!movie) return undefined;
  movie.characters = characters;
  // Propagate character voice assignment and gender to existing dialogue segments
  const charMap = new Map(characters.map((c) => [c.speakerLabel, c]));
  movie.segments = movie.segments.map((seg) => {
    const char = charMap.get(seg.speakerLabel);
    if (!char) return seg;
    return {
      ...seg,
      voiceProfileId: char.voiceProfileId,
      gender: char.gender,
    };
  });
  movie.updatedAt = new Date().toISOString();
  persistSyncSafe();
  return movie;
}

export function deleteMovieRecord(id: string): boolean {
  const movie = db.movies[id];
  if (!movie) return false;
  delete db.movies[id];
  persistSyncSafe();
  return true;
}

export function createUploadSession(session: UploadSession): UploadSession {
  db.uploadSessions[session.uploadId] = session;
  persistSyncSafe();
  return session;
}

export function getUploadSession(uploadId: string): UploadSession | undefined {
  return db.uploadSessions[uploadId];
}

export function updateUploadSession(
  uploadId: string,
  patch: Partial<UploadSession>
): UploadSession | undefined {
  const existing = db.uploadSessions[uploadId];
  if (!existing) return undefined;
  db.uploadSessions[uploadId] = { ...existing, ...patch };
  persistSyncSafe();
  return db.uploadSessions[uploadId];
}

export function deleteUploadSession(uploadId: string): void {
  delete db.uploadSessions[uploadId];
  persistSyncSafe();
}
