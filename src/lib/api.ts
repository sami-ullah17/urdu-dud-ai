import { firebaseAuth } from './firebase';
import type {
  CharacterProfile,
  DashboardStats,
  MovieProject,
  ProviderHealth,
  StudioUserSession,
  UrduVoiceProfile,
} from '../types/studio';

const TOKEN_STORAGE_KEY = 'urdudub_studio_token';

export function getStoredAuthToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredAuthToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function resolveBearerToken(): Promise<string | null> {
  if (firebaseAuth?.currentUser) {
    try {
      const freshToken = await firebaseAuth.currentUser.getIdToken();
      setStoredAuthToken(freshToken);
      return freshToken;
    } catch {
      return getStoredAuthToken();
    }
  }
  return getStoredAuthToken();
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await resolveBearerToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { error: text || `Request failed with status ${res.status}` };
  }

  if (!res.ok) {
    const err = new Error(
      typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    ) as Error & { code?: string; status?: number };
    err.code = typeof data.code === 'string' ? data.code : undefined;
    err.status = res.status;
    throw err;
  }

  return data as T;
}

export async function createStudioSession(email: string, displayName: string) {
  const result = await apiFetch<{ token: string; user: StudioUserSession }>(
    '/api/auth/studio-session',
    {
      method: 'POST',
      body: JSON.stringify({ email, displayName }),
    }
  );
  setStoredAuthToken(result.token);
  return result.user;
}

export async function fetchCurrentUser(): Promise<StudioUserSession> {
  const res = await apiFetch<{ user: StudioUserSession }>('/api/auth/me');
  return res.user;
}

export async function fetchProviderHealth(): Promise<ProviderHealth> {
  return apiFetch<ProviderHealth>('/api/health/providers');
}

export async function fetchUrduVoices(): Promise<UrduVoiceProfile[]> {
  const res = await apiFetch<{ voices: UrduVoiceProfile[] }>('/api/voices');
  return res.voices;
}

export async function previewUrduVoice(
  voiceProfileId: string,
  text?: string
): Promise<{ audioBase64: string; mimeType: string; sampleText: string }> {
  return apiFetch('/api/voices/preview', {
    method: 'POST',
    body: JSON.stringify({ voiceProfileId, text }),
  });
}

export async function fetchMovies(): Promise<{
  stats: DashboardStats;
  movies: MovieProject[];
}> {
  return apiFetch('/api/movies');
}

export async function fetchMovieDetail(id: string): Promise<MovieProject> {
  const res = await apiFetch<{ movie: MovieProject }>(`/api/movies/${id}`);
  return res.movie;
}

export async function createSampleTurkishMovie(): Promise<MovieProject> {
  const res = await apiFetch<{ movie: MovieProject }>('/api/movies/sample-turkish', {
    method: 'POST',
  });
  return res.movie;
}

export interface UploadProgressInfo {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  mbPerSec: number;
}

export async function uploadMovieResumable(params: {
  file: File;
  title: string;
  rightsConfirmed: boolean;
  onProgress: (info: UploadProgressInfo) => void;
  signal?: AbortSignal;
}): Promise<MovieProject> {
  const initRes = await apiFetch<{ uploadId: string; maxChunkSizeBytes: number }>(
    '/api/movies/upload/init',
    {
      method: 'POST',
      body: JSON.stringify({
        filename: params.file.name,
        title: params.title,
        fileSizeBytes: params.file.size,
        rightsConfirmed: params.rightsConfirmed,
      }),
      signal: params.signal,
    }
  );

  const chunkSize = Math.min(8 * 1024 * 1024, initRes.maxChunkSizeBytes || 8 * 1024 * 1024);
  const totalBytes = params.file.size;
  let offset = 0;
  const startedAt = Date.now();

  while (offset < totalBytes) {
    if (params.signal?.aborted) {
      throw new Error('Upload cancelled by user.');
    }
    const end = Math.min(totalBytes, offset + chunkSize);
    const slice = params.file.slice(offset, end);
    const token = await resolveBearerToken();

    const chunkRes = await fetch(`/api/movies/upload/chunk/${initRes.uploadId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: slice,
      signal: params.signal,
    });

    if (!chunkRes.ok) {
      const errData = (await chunkRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(errData.error || `Chunk upload failed at offset ${offset}.`);
    }

    offset = end;
    const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
    params.onProgress({
      uploadedBytes: offset,
      totalBytes,
      percent: Math.round((offset / totalBytes) * 100),
      mbPerSec: Number((offset / (1024 * 1024) / elapsedSec).toFixed(2)),
    });
  }

  const completeRes = await apiFetch<{ movie: MovieProject }>(
    `/api/movies/upload/complete/${initRes.uploadId}`,
    {
      method: 'POST',
      signal: params.signal,
    }
  );
  return completeRes.movie;
}

export async function startDubbingJob(
  id: string,
  options: {
    mode: 'scan' | 'full' | 'resume_chunks';
    demoMode?: boolean;
    confirmLongMovie?: boolean;
  }
): Promise<MovieProject> {
  const res = await apiFetch<{ movie: MovieProject }>(`/api/dubbing/${id}/start`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
  return res.movie;
}

export async function saveMovieCharacters(
  id: string,
  characters: CharacterProfile[]
): Promise<MovieProject> {
  const res = await apiFetch<{ movie: MovieProject }>(`/api/dubbing/${id}/characters`, {
    method: 'PUT',
    body: JSON.stringify({ characters }),
  });
  return res.movie;
}

export async function deleteMovieProject(id: string): Promise<void> {
  await apiFetch(`/api/movies/${id}`, { method: 'DELETE' });
}
