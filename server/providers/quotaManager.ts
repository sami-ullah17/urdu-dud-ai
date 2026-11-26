import crypto from 'node:crypto';
import { getQuotaState, saveQuotaState } from '../store.ts';
import type { ModelQuotaRecord, QuotaStateStore } from '../types.ts';
import {
  classifyGeminiError,
  JobCancelledError,
  QuotaExhaustedError,
  sleepWithCancel,
  withRetry,
} from './geminiClient.ts';

function getKeyFingerprint(): string {
  const key = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (!key) return 'none';
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function getCurrentPtDate(now = new Date()): string {
  // Google AI Studio / Gemini Free Tier daily quotas reset at midnight Pacific Time
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function getNextPtMidnightIso(now = new Date()): string {
  const todayPt = getCurrentPtDate(now);
  // Step forward in 15-minute increments (at most ~104 steps = <1ms) until PT date rolls over, then refine to minute
  let ts = now.getTime();
  while (getCurrentPtDate(new Date(ts)) === todayPt) {
    ts += 15 * 60 * 1000;
  }
  while (getCurrentPtDate(new Date(ts - 60 * 1000)) !== todayPt) {
    ts -= 60 * 1000;
  }
  const d = new Date(ts);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

function getConfiguredDailyLimit(model: string): number | undefined {
  if (model.includes('tts')) {
    const raw = Number(process.env.GEMINI_TTS_DAILY_LIMIT ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  }
  const raw = Number(process.env.GEMINI_TEXT_DAILY_LIMIT ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function getDefaultMinIntervalMs(model: string): number {
  if (model.includes('tts')) {
    const raw = Number(process.env.GEMINI_TTS_MIN_INTERVAL_MS ?? 4500);
    return Number.isFinite(raw) && raw >= 0 ? raw : 4500;
  }
  const raw = Number(process.env.GEMINI_API_MIN_INTERVAL_MS ?? 1200);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1200;
}

function syncStoreForToday(): QuotaStateStore {
  const state = getQuotaState();
  const fp = getKeyFingerprint();
  const todayPt = getCurrentPtDate();
  let mutated = false;

  if (state.keyFingerprint && state.keyFingerprint !== fp) {
    // New API key configured — reset old key's quota tracking cleanly
    state.models = {};
    state.keyFingerprint = fp;
    mutated = true;
  } else if (!state.keyFingerprint) {
    state.keyFingerprint = fp;
    mutated = true;
  }

  for (const [modelName, rec] of Object.entries(state.models)) {
    if (rec.datePt !== todayPt) {
      state.models[modelName] = {
        model: modelName,
        datePt: todayPt,
        requestCount: 0,
        minIntervalMs: rec.minIntervalMs,
      };
      mutated = true;
    }
  }

  if (mutated) {
    return saveQuotaState(state);
  }
  return state;
}

function getOrCreateModelRecord(model: string): ModelQuotaRecord {
  const state = syncStoreForToday();
  const todayPt = getCurrentPtDate();
  const existing = state.models[model];
  if (existing && existing.datePt === todayPt) {
    return existing;
  }
  const fresh: ModelQuotaRecord = {
    model,
    datePt: todayPt,
    requestCount: 0,
    minIntervalMs: getDefaultMinIntervalMs(model),
  };
  state.models[model] = fresh;
  saveQuotaState(state);
  return fresh;
}

export function isModelQuotaAvailable(model: string): boolean {
  const rec = getOrCreateModelRecord(model);
  const nowMs = Date.now();
  if (rec.exhaustedUntilIso && new Date(rec.exhaustedUntilIso).getTime() > nowMs) {
    return false;
  }
  const configuredCap = getConfiguredDailyLimit(model);
  const effectiveCap =
    configuredCap && rec.observedDailyLimit
      ? Math.min(configuredCap, rec.observedDailyLimit)
      : configuredCap ?? rec.observedDailyLimit;

  if (effectiveCap && effectiveCap > 0 && rec.requestCount >= effectiveCap) {
    return false;
  }
  return true;
}

export function markModelDailyQuotaExhausted(
  model: string,
  reason: string,
  observedDailyLimit?: number
): string {
  const state = syncStoreForToday();
  const rec = getOrCreateModelRecord(model);
  const resetAtIso = getNextPtMidnightIso();
  state.models[model] = {
    ...rec,
    exhaustedUntilIso: resetAtIso,
    lastError: reason.slice(0, 300),
    observedDailyLimit:
      observedDailyLimit !== undefined && observedDailyLimit > 0
        ? observedDailyLimit
        : rec.observedDailyLimit,
  };
  saveQuotaState(state);
  return resetAtIso;
}

function recordDispatch(model: string): ModelQuotaRecord {
  const state = syncStoreForToday();
  const rec = getOrCreateModelRecord(model);
  const updated: ModelQuotaRecord = {
    ...rec,
    requestCount: rec.requestCount + 1,
    lastRequestAtMs: Date.now(),
  };
  state.models[model] = updated;
  saveQuotaState(state);
  return updated;
}

function bumpModelMinInterval(model: string, minMs: number): void {
  const state = syncStoreForToday();
  const rec = getOrCreateModelRecord(model);
  const nextInterval = Math.min(25_000, Math.max(rec.minIntervalMs ?? 0, minMs));
  state.models[model] = {
    ...rec,
    minIntervalMs: nextInterval,
  };
  saveQuotaState(state);
}

// Single sequential request queue so parallel/burst requests never exceed Free Tier RPM/RPD
let queueTail: Promise<void> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Executes a Gemini API call inside the persistent request queue:
 * - Pre-flight daily quota check (never exceeds daily limit once reached or configured).
 * - Polite per-minute pacing to minimize RPM 429 bursts.
 * - Safe exponential backoff for temporary non-quota errors (up to 5 attempts).
 * - Immediate QuotaExhaustedError on daily 429 RESOURCE_EXHAUSTED (at most 1 polite retry on explicit short RPM retryDelay).
 */
export async function executeQueuedGeminiCall<T>(params: {
  model: string;
  label: string;
  maxTransientAttempts?: number;
  shouldCancel?: () => boolean;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  fn: () => Promise<T>;
}): Promise<T> {
  return runSerialized(async () => {
    if (params.shouldCancel?.()) {
      throw new JobCancelledError();
    }

    const executeAttemptOnce = async () => {
      const rec = getOrCreateModelRecord(params.model);
      if (!isModelQuotaAvailable(params.model)) {
        const resetAt = rec.exhaustedUntilIso ?? getNextPtMidnightIso();
        throw new QuotaExhaustedError(
          params.model,
          resetAt,
          `Daily quota already reached for ${params.model} (${rec.requestCount} requests used today, PT day ${rec.datePt}). Paused until quota resets.`
        );
      }

      // Enforce polite RPM spacing before dispatch
      const minGap = rec.minIntervalMs ?? getDefaultMinIntervalMs(params.model);
      if (minGap > 0 && rec.lastRequestAtMs) {
        const elapsedSinceLast = Date.now() - rec.lastRequestAtMs;
        if (elapsedSinceLast < minGap) {
          await sleepWithCancel(minGap - elapsedSinceLast, params.shouldCancel);
        }
      }

      recordDispatch(params.model);
      return params.fn();
    };

    const runWithSingleRpmCheck = async () => {
      try {
        return await executeAttemptOnce();
      } catch (err) {
        const classified = classifyGeminiError(err);
        if (classified.category !== 'quota') {
          throw err;
        }

        // Daily quota or no explicit short per-minute retryDelay -> stop immediately without retrying!
        if (
          classified.isDailyQuota ||
          !classified.retryAfterMs ||
          classified.retryAfterMs > 75_000
        ) {
          const resetAt = markModelDailyQuotaExhausted(
            params.model,
            classified.message,
            classified.observedLimit
          );
          throw new QuotaExhaustedError(
            params.model,
            resetAt,
            `Gemini API quota exhausted for ${params.model} (429 RESOURCE_EXHAUSTED). Processing paused cleanly.`
          );
        }

        // Short per-minute RPM cooldown: adapt pacing and try ONE single polite retry (never continuous!)
        params.onLog?.(
          'warn',
          `${params.model} per-minute rate limit reached; pausing ${(classified.retryAfterMs / 1000).toFixed(0)}s before one polite retry.`
        );
        bumpModelMinInterval(params.model, Math.min(22_000, classified.retryAfterMs));
        await sleepWithCancel(classified.retryAfterMs, params.shouldCancel);

        try {
          return await executeAttemptOnce();
        } catch (secondErr) {
          const secondClassified = classifyGeminiError(secondErr);
          if (secondClassified.category === 'quota') {
            const resetAt = markModelDailyQuotaExhausted(
              params.model,
              secondClassified.message,
              secondClassified.observedLimit
            );
            throw new QuotaExhaustedError(
              params.model,
              resetAt,
              `Gemini API quota exhausted for ${params.model} after rate-limit cooldown. Processing paused cleanly.`
            );
          }
          throw secondErr;
        }
      }
    };

    return withRetry(() => runWithSingleRpmCheck(), {
      maxAttempts: params.maxTransientAttempts ?? 5,
      baseDelayMs: 2000,
      maxDelayMs: 30_000,
      label: params.label,
      shouldCancel: params.shouldCancel,
    });
  });
}

export function getQuotaDiagnostics() {
  const state = syncStoreForToday();
  const todayPt = getCurrentPtDate();
  const nextResetIso = getNextPtMidnightIso();

  const models = Object.values(state.models).map((rec) => {
    const configuredCap = getConfiguredDailyLimit(rec.model);
    const effectiveCap =
      configuredCap && rec.observedDailyLimit
        ? Math.min(configuredCap, rec.observedDailyLimit)
        : configuredCap ?? rec.observedDailyLimit;

    return {
      model: rec.model,
      datePt: rec.datePt,
      requestCount: rec.requestCount,
      configuredOrObservedLimit: effectiveCap ?? null,
      exhaustedToday: Boolean(
        (rec.exhaustedUntilIso && new Date(rec.exhaustedUntilIso).getTime() > Date.now()) ||
          (effectiveCap && effectiveCap > 0 && rec.requestCount >= effectiveCap)
      ),
      exhaustedUntilIso: rec.exhaustedUntilIso ?? null,
    };
  });

  const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
  const allTtsExhausted = ttsModels.every((m) => !isModelQuotaAvailable(m));

  return {
    ptDate: todayPt,
    nextResetIso,
    allTtsExhaustedToday: allTtsExhausted,
    models,
  };
}
