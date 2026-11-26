import { GoogleGenAI } from '@google/genai';

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class JobCancelledError extends Error {
  readonly code = 'JOB_CANCELLED';
  constructor(message = 'Job was paused or cancelled by user.') {
    super(message);
    this.name = 'JOB_CANCELLED';
  }
}

export class QuotaExhaustedError extends Error {
  readonly code = 'QUOTA_EXHAUSTED';
  readonly model: string;
  readonly resetAtIso: string;
  readonly isDailyLimit: boolean;

  constructor(model: string, resetAtIso: string, message: string, isDailyLimit = true) {
    super(message);
    this.name = 'QUOTA_EXHAUSTED';
    this.model = model;
    this.resetAtIso = resetAtIso;
    this.isDailyLimit = isDailyLimit;
  }
}

export type ErrorCategory = 'permanent' | 'temporary' | 'quota' | 'cancelled';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  isTimeout: boolean;
  isRateLimit: boolean;
  isDailyQuota: boolean;
  retryAfterMs?: number;
  observedLimit?: number;
}

export function parseRetryAfterMs(rawMsg: string): number | undefined {
  // Matches Gemini messages like "Please retry in 21.085129121s." or `"retryDelay":"21s"`
  const secMatch = rawMsg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (secMatch?.[1]) {
    const sec = Number(secMatch[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.ceil(sec * 1000) + 1200;
    }
  }
  const jsonMatch = rawMsg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (jsonMatch?.[1]) {
    const sec = Number(jsonMatch[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.ceil(sec * 1000) + 1200;
    }
  }
  return undefined;
}

function parseObservedQuotaValue(rawMsg: string): number | undefined {
  const m = rawMsg.match(/"quotaValue"\s*:\s*"(\d+)"/i);
  if (m?.[1]) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  return undefined;
}

export function classifyGeminiError(err: unknown): ClassifiedError {
  if (err instanceof JobCancelledError) {
    return {
      category: 'cancelled',
      message: err.message,
      isTimeout: false,
      isRateLimit: false,
      isDailyQuota: false,
    };
  }

  if (err instanceof QuotaExhaustedError) {
    return {
      category: 'quota',
      message: err.message,
      isTimeout: false,
      isRateLimit: true,
      isDailyQuota: err.isDailyLimit,
    };
  }

  const rawMsg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const lower = rawMsg.toLowerCase();

  const isRateLimit =
    lower.includes('resource_exhausted') ||
    lower.includes('"code":429') ||
    lower.includes('429 too many requests') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('rate-limit') ||
    lower.includes('per minute limit');

  const isDailyQuota =
    isRateLimit &&
    (lower.includes('perday') ||
      lower.includes('requestsperday') ||
      lower.includes('per_day') ||
      (lower.includes('daily') && lower.includes('quota')) ||
      lower.includes('"quotavalue":"0"') ||
      lower.includes('limit: 0'));

  if (isRateLimit) {
    const retryAfterMs = parseRetryAfterMs(rawMsg);
    return {
      category: 'quota',
      message: rawMsg,
      isTimeout: false,
      isRateLimit: true,
      isDailyQuota: isDailyQuota || retryAfterMs === undefined,
      retryAfterMs,
      observedLimit: isDailyQuota ? parseObservedQuotaValue(rawMsg) : undefined,
    };
  }

  // Permanent non-quota errors (auth/permission/missing file/bad input)
  if (
    err instanceof ProviderNotConfiguredError ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('status":403') ||
    lower.includes('403 forbidden') ||
    lower.includes('not_found') ||
    lower.includes('status":404') ||
    lower.includes('enoent') ||
    lower.includes('unsupported mime') ||
    lower.includes('invalid argument') ||
    lower.includes('invalid_argument') ||
    lower.includes('file does not exist')
  ) {
    return {
      category: 'permanent',
      message: rawMsg,
      isTimeout: false,
      isRateLimit: false,
      isDailyQuota: false,
    };
  }

  const isTimeout =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    lower.includes('aborted') ||
    lower.includes('timeout') ||
    lower.includes('deadline_exceeded') ||
    lower.includes('etimedout') ||
    lower.includes('504');

  return {
    category: 'temporary',
    message: rawMsg,
    isTimeout,
    isRateLimit: false,
    isDailyQuota: false,
  };
}

export function hasGeminiKey(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.length > 10);
}

export function getGeminiClient(timeoutMs = 180_000): GoogleGenAI {
  if (!hasGeminiKey()) {
    throw new ProviderNotConfiguredError(
      'GEMINI_API_KEY is not configured in the server environment. Configure GEMINI_API_KEY in Settings > Secrets or enable clearly labeled Demo Mode.'
    );
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    apiVersion: 'v1beta',
    httpOptions: {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function sleepWithCancel(ms: number, shouldCancel?: () => boolean): Promise<void> {
  const stepMs = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldCancel?.()) {
      throw new JobCancelledError();
    }
    const wait = Math.min(stepMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, wait));
    elapsed += wait;
  }
  if (shouldCancel?.()) {
    throw new JobCancelledError();
  }
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    label?: string;
    shouldCancel?: () => boolean;
    onAttemptError?: (attempt: number, maxAttempts: number, classified: ClassifiedError, elapsedMs: number) => void;
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.shouldCancel?.()) {
      throw new JobCancelledError();
    }
    const t0 = Date.now();
    try {
      const result = await fn(attempt);
      if (options.label) {
        console.log(`[Gemini] ${options.label} succeeded in ${Date.now() - t0}ms (attempt ${attempt}/${maxAttempts})`);
      }
      return result;
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - t0;
      const classified = classifyGeminiError(err);
      console.warn(
        `[Gemini] ${options.label ?? 'call'} attempt ${attempt}/${maxAttempts} (${classified.category}) failed after ${elapsedMs}ms: ${classified.message.slice(0, 240)}`
      );
      options.onAttemptError?.(attempt, maxAttempts, classified, elapsedMs);

      // Never continuously retry quota errors, permanent errors, or cancelled jobs
      if (
        classified.category === 'cancelled' ||
        classified.category === 'permanent' ||
        classified.category === 'quota' ||
        attempt === maxAttempts
      ) {
        throw err;
      }

      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delayMs = expDelay + Math.floor(Math.random() * 600);
      await sleepWithCancel(delayMs, options.shouldCancel);
    }
  }
  throw lastError;
}
