import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { upsertUser, getUser } from './store.ts';

const SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'change-this-in-production'
    ? process.env.SESSION_SECRET
    : crypto
        .createHash('sha256')
        .update(`${process.cwd()}-${process.env.GEMINI_API_KEY ?? 'local-studio'}`)
        .digest('hex');

export interface AuthenticatedUser {
  uid: string;
  email: string;
  displayName: string;
  authMode: 'firebase' | 'studio-local';
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

export function issueStudioToken(user: {
  uid: string;
  email: string;
  displayName: string;
}): string {
  const payload = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', SECRET).update(encoded).digest()
  );
  return `studio.${encoded}.${sig}`;
}

function verifyStudioToken(token: string): AuthenticatedUser | null {
  if (!token.startsWith('studio.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encoded, sig] = parts;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', SECRET).update(encoded).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as {
      uid: string;
      email: string;
      displayName: string;
      exp: number;
    };
    if (!parsed.uid || Date.now() > parsed.exp) return null;
    return {
      uid: parsed.uid,
      email: parsed.email,
      displayName: parsed.displayName,
      authMode: 'studio-local',
    };
  } catch {
    return null;
  }
}

let cachedFirebaseProjectId: string | null = null;
function getConfiguredFirebaseProjectId(): string | null {
  if (cachedFirebaseProjectId !== null) return cachedFirebaseProjectId || null;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectId?: string };
      if (cfg.projectId && cfg.projectId !== 'remixed-project-id') {
        cachedFirebaseProjectId = cfg.projectId;
        return cfg.projectId;
      }
    } catch {
      // ignore invalid file
    }
  }
  cachedFirebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID || '';
  return cachedFirebaseProjectId || null;
}

let cachedCerts: { keys: Record<string, string>; expiresAt: number } = {
  keys: {},
  expiresAt: 0,
};

async function getFirebasePublicKeys(): Promise<Record<string, string>> {
  if (Date.now() < cachedCerts.expiresAt && Object.keys(cachedCerts.keys).length > 0) {
    return cachedCerts.keys;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error('Unable to fetch Firebase public verification certificates.');
  }
  const keys = (await resp.json()) as Record<string, string>;
  cachedCerts = {
    keys,
    expiresAt: Date.now() + 3600 * 1000,
  };
  return keys;
}

async function verifyFirebaseIdToken(token: string): Promise<AuthenticatedUser | null> {
  const projectId = getConfiguredFirebaseProjectId();
  if (!projectId) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0])) as { alg?: string; kid?: string };
    const payload = JSON.parse(base64UrlDecode(parts[1])) as {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      email?: string;
      name?: string;
    };
    if (header.alg !== 'RS256' || !header.kid) return null;
    if (payload.aud !== projectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!payload.sub || !payload.exp || payload.exp * 1000 < Date.now()) return null;

    const certs = await getFirebasePublicKeys();
    const cert = certs[header.kid];
    if (!cert) return null;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    const sigNorm = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const valid = verifier.verify(cert, sigNorm, 'base64');
    if (!valid) return null;

    return {
      uid: payload.sub,
      email: payload.email ?? 'user@urdudub.ai',
      displayName: payload.name ?? 'Studio Creator',
      authMode: 'firebase',
    };
  } catch {
    return null;
  }
}

export function signDownloadUrlToken(
  movieId: string,
  ownerId: string,
  type: 'mp4' | 'srt' | 'source'
): string {
  const exp = Date.now() + 60 * 60 * 1000; // 1 hour expiry
  const payload = `${movieId}:${ownerId}:${type}:${exp}`;
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', SECRET).update(payload).digest()
  );
  return `${exp}.${sig}`;
}

export function verifyDownloadUrlToken(
  movieId: string,
  ownerId: string,
  type: string,
  token: string
): boolean {
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!expStr || !sig || !Number.isFinite(exp) || Date.now() > exp) return false;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', SECRET).update(`${movieId}:${ownerId}:${type}:${exp}`).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export async function resolveAuthFromRequest(req: Request): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : null;
  const token = bearer || queryToken;
  if (!token) return null;

  const studioUser = verifyStudioToken(token);
  if (studioUser) {
    if (!getUser(studioUser.uid)) {
      upsertUser({
        uid: studioUser.uid,
        email: studioUser.email,
        displayName: studioUser.displayName,
        shortClipVerified: false,
        createdAt: new Date().toISOString(),
      });
    }
    return studioUser;
  }

  const fbUser = await verifyFirebaseIdToken(token);
  if (fbUser) {
    if (!getUser(fbUser.uid)) {
      upsertUser({
        uid: fbUser.uid,
        email: fbUser.email,
        displayName: fbUser.displayName,
        shortClipVerified: false,
        createdAt: new Date().toISOString(),
      });
    }
    return fbUser;
  }

  return null;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = await resolveAuthFromRequest(req);
  if (!user) {
    res.status(401).json({
      error: 'Authentication required. Please sign in to access UrduDub AI studio endpoints.',
    });
    return;
  }
  req.user = user;
  next();
}
