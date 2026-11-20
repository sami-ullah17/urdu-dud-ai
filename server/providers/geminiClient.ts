import { GoogleGenAI } from '@google/genai';

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export function hasGeminiKey(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.length > 10);
}

export function getGeminiClient(timeoutMs = 45000): GoogleGenAI {
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

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1200;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const result = await fn();
      if (options.label) {
        console.log(`[Gemini] ${options.label} succeeded in ${Date.now() - t0}ms`);
      }
      return result;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Gemini] ${options.label ?? 'call'} attempt ${attempt}/${maxAttempts} failed after ${Date.now() - t0}ms: ${msg.slice(0, 220)}`
      );
      const isNonRetryable =
        msg.includes('API_KEY_INVALID') ||
        msg.includes('PERMISSION_DENIED') ||
        err instanceof ProviderNotConfiguredError;
      if (isNonRetryable || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
