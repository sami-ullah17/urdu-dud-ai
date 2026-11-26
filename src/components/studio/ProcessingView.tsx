import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Mic2,
  PauseCircle,
  Play,
  RotateCcw,
} from 'lucide-react';
import { cancelDubbingJob, resumeDubbingJob, startDubbingJob } from '../../lib/api';
import { PROCESSING_STAGES, type MovieProject, type ProviderHealth } from '../../types/studio';

interface ProcessingViewProps {
  movie: MovieProject | null;
  health: ProviderHealth | null;
  onMovieUpdated: (movie: MovieProject) => void;
  onGoToCharacters: () => void;
  onGoToDownload: () => void;
}

function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'Calculating after first chunk';
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (mins === 0) return `${rem}s remaining`;
  return `${mins}m ${rem}s remaining`;
}

function formatResetTime(iso: string | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function ProcessingView({
  movie,
  health,
  onMovieUpdated,
  onGoToCharacters,
  onGoToDownload,
}: ProcessingViewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!movie) {
    return (
      <div className="rounded-xl bg-[#0F1429] border border-white/10 p-10 text-center space-y-2">
        <Activity className="w-8 h-8 text-slate-500 mx-auto" />
        <h2 className="text-lg font-medium text-white">No Active Processing Job</h2>
        <p className="text-sm text-slate-400">
          Select a movie from the Dashboard or upload a Turkish film to inspect its 10-stage
          pipeline.
        </p>
      </div>
    );
  }

  async function triggerJob(mode: 'scan' | 'full' | 'resume_chunks', demoMode = false) {
    if (!movie) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await startDubbingJob(movie.id, {
        mode,
        demoMode,
        confirmLongMovie: true,
      });
      onMovieUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start processing job.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResumeProcessing() {
    if (!movie) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await resumeDubbingJob(movie.id);
      onMovieUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resume processing job.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePauseJob() {
    if (!movie) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await cancelDubbingJob(movie.id);
      onMovieUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to pause job.');
    } finally {
      setBusy(false);
    }
  }

  const isActive =
    movie.status === 'processing' || movie.status === 'queued' || movie.status === 'scanning';
  const isPaused = movie.status === 'paused';
  const isQuotaPaused = isPaused && movie.pauseReason === 'quota_exhausted';

  const pendingCount = movie.chunkStates.filter((c) => c.status === 'pending').length;
  const processingCount = movie.chunkStates.filter((c) => c.status === 'processing').length;
  const completedCount = movie.chunkStates.filter((c) => c.status === 'completed').length;
  const failedCount = movie.chunkStates.filter((c) => c.status === 'failed').length;
  const remainingSpeechChunks = Math.max(0, movie.chunkStates.length - completedCount);

  const totalTtsChunks = movie.totalTtsChunks ?? movie.segmentsCount ?? 0;
  const completedTtsChunks = movie.completedTtsChunks ?? 0;
  const remainingTtsChunks =
    movie.remainingTtsChunks ?? Math.max(0, totalTtsChunks - completedTtsChunks);

  const hasIncompleteWork =
    remainingSpeechChunks > 0 || remainingTtsChunks > 0 || failedCount > 0;
  const showResumeButton =
    !isActive &&
    (isPaused || movie.status === 'failed' || (movie.status !== 'completed' && hasIncompleteWork && movie.chunkStates.length > 0));

  const resetTimeLabel = formatResetTime(movie.quotaResetAt ?? health?.quota?.nextResetIso);
  const ttsUsageModels = (health?.quota?.models ?? []).filter((m) => m.model.includes('tts'));

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{movie.originalFilename}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{(movie.durationSeconds / 60).toFixed(2)} min</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">
              {movie.status.replace(/_/g, ' ')}
              {movie.demoMode ? ' (Demo Mode)' : ''}
            </span>
          </div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">{movie.title}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {movie.status === 'ready_for_dubbing' && (
            <>
              <button
                type="button"
                onClick={onGoToCharacters}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/15 bg-[#0F1429] hover:bg-white/5 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                <Mic2 className="w-3.5 h-3.5" />
                Review Character Voices ({movie.characters.length})
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => triggerJob('full')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                Start Full Dubbing
              </button>
            </>
          )}

          {movie.status === 'uploaded' && (
            <>
              {health?.geminiConfigured ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => triggerJob('scan')}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/15 bg-[#0F1429] hover:bg-white/5 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Mic2 className="w-3.5 h-3.5" />
                    Scan Speakers First
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => triggerJob('full')}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Start Full Dubbing
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => triggerJob('full', true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer"
                >
                  Run Clearly Labeled Demo Mode
                </button>
              )}
            </>
          )}

          {isActive && (
            <button
              type="button"
              disabled={busy}
              onClick={handlePauseJob}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-500/35 bg-amber-950/30 hover:bg-amber-900/40 text-amber-200 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <PauseCircle className="w-3.5 h-3.5" />
              Pause Processing
            </button>
          )}

          {showResumeButton && (
            <button
              type="button"
              disabled={busy}
              onClick={handleResumeProcessing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Resume Processing
            </button>
          )}

          {movie.status === 'completed' && (
            <button
              type="button"
              onClick={onGoToDownload}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Open Download &amp; Preview
            </button>
          )}
        </div>
      </div>

      {isActive && (
        <div className="p-3.5 rounded-xl bg-indigo-950/35 border border-indigo-500/25 text-xs text-slate-200 flex items-center justify-between gap-3">
          <span>
            Background processing active on the server. Completed speech and Urdu audio chunks are
            saved continuously—you can safely refresh or close this browser tab and return anytime.
          </span>
        </div>
      )}

      {isPaused && (
        <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/30 flex items-start gap-3 text-xs text-amber-100 leading-relaxed">
          <PauseCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-amber-200">
              {isQuotaPaused
                ? 'Paused Automatically — Gemini Free Tier Quota Reached'
                : 'Processing Paused — Progress Saved'}
            </p>
            <p className="text-amber-100/90">
              {completedCount} / {movie.totalChunks || movie.chunkStates.length} Turkish speech chunks and{' '}
              {completedTtsChunks} / {totalTtsChunks} Urdu voice chunks are safely persisted ({remainingTtsChunks}{' '}
              Urdu audio chunks remaining). Completed chunks will not be regenerated.
            </p>
            {isQuotaPaused && (
              <p className="text-amber-200/80">
                {resetTimeLabel ? `Estimated quota reset: ${resetTimeLabel}. ` : ''}
                You can resume tomorrow without re-uploading the movie. Exact completion duration
                depends on Google&apos;s active Free Tier API limits, which may change at any time.
              </p>
            )}
          </div>
        </div>
      )}

      {movie.demoMode && (
        <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/30 text-xs text-amber-200 leading-relaxed">
          Demo Mode is active for this project because live AI keys were unavailable. Outputs
          generated in Demo Mode are clearly marked as sample previews and do not represent real
          Turkish-to-Urdu speech translation.
        </div>
      )}

      {(error || (movie.error && !isPaused)) && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/30 flex items-start gap-3 text-sm text-rose-200">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">Processing Error</p>
            <p className="text-xs text-rose-200/90 leading-relaxed">{error || movie.error}</p>
          </div>
        </div>
      )}

      {/* Real Progress Header Card */}
      <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs text-slate-400">Current Stage</span>
            <p className="text-lg font-medium text-white flex items-center gap-2">
              {isActive && <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />}
              {isPaused && <PauseCircle className="w-4 h-4 text-amber-400" />}
              <span>{movie.currentStage}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-right tabular-nums">
            <div>
              <span className="block text-xs text-slate-400">Speech Chunks</span>
              <span className="text-sm font-mono text-white">
                {movie.completedChunks} / {movie.totalChunks || 1}
              </span>
            </div>
            <div>
              <span className="block text-xs text-slate-400">Urdu Audio Chunks</span>
              <span className="text-sm font-mono text-white">
                {completedTtsChunks} / {totalTtsChunks}
              </span>
              {totalTtsChunks > 0 && (
                <span className="block text-[11px] text-slate-400">
                  {remainingTtsChunks} remaining
                </span>
              )}
            </div>
            <div>
              <span className="block text-xs text-slate-400">Estimated Remaining</span>
              <span className="text-sm font-mono text-slate-200 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                {movie.status === 'completed'
                  ? 'Completed'
                  : isPaused
                    ? 'Paused'
                    : isActive
                      ? formatDuration(movie.etaSeconds)
                      : '—'}
              </span>
            </div>
            <div>
              <span className="block text-xs text-slate-400">Progress</span>
              <span className="text-xl font-mono font-semibold text-violet-300">
                {movie.progressPercent}%
              </span>
            </div>
          </div>
        </div>

        <div className="h-2.5 rounded-full bg-[#080B18] overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-all duration-300"
            style={{ width: `${movie.progressPercent}%` }}
          />
        </div>

        {health?.quota && (
          <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>
              Gemini Free Tier Queue (PT Date: <span className="font-mono text-slate-200">{health.quota.ptDate}</span>)
            </span>
            <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
              {ttsUsageModels.length > 0 ? (
                ttsUsageModels.map((m) => (
                  <span
                    key={m.model}
                    className={m.exhaustedToday ? 'text-amber-300' : 'text-slate-300'}
                  >
                    {m.model}: {m.requestCount}
                    {m.configuredOrObservedLimit ? `/${m.configuredOrObservedLimit}` : ' reqs'}
                    {m.exhaustedToday ? ' (exhausted today)' : ''}
                  </span>
                ))
              ) : (
                <span>Sequential queue active — respects daily &amp; per-minute limits</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 10-Stage Pipeline Stepper + Persistent Chunk Grid */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
          <h2 className="text-base font-semibold text-white">10-Stage Dubbing Pipeline</h2>
          <ol className="space-y-2.5">
            {PROCESSING_STAGES.map((stageName, idx) => {
              const isDone =
                movie.status === 'completed' || idx < movie.stageIndex;
              const isCurrent =
                movie.status !== 'completed' && idx === movie.stageIndex && isActive;
              const isFailedStage =
                movie.status === 'failed' && idx === movie.stageIndex;

              return (
                <li
                  key={stageName}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg border text-sm ${
                    isCurrent
                      ? 'bg-violet-950/40 border-violet-500/40 text-white'
                      : isFailedStage
                        ? 'bg-rose-950/35 border-rose-500/35 text-rose-200'
                        : isDone
                          ? 'bg-[#080B18]/60 border-white/10 text-slate-200'
                          : 'bg-[#080B18]/30 border-white/5 text-slate-500'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs tabular-nums w-5 text-slate-400">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span>{stageName}</span>
                  </div>

                  <span className="text-xs flex items-center gap-1.5">
                    {isDone && (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Done</span>
                      </>
                    )}
                    {isCurrent && (
                      <>
                        <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                        <span className="text-violet-300">Active</span>
                      </>
                    )}
                    {isFailedStage && <span className="text-rose-300">Failed</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="lg:col-span-6 space-y-6">
          {/* Chunk Matrix */}
          <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-white">Audio Chunk Segments</h2>
              <span className="text-xs text-slate-400 tabular-nums">
                {movie.chunkStates.length} total segment(s)
              </span>
            </div>

            {movie.chunkStates.length > 0 && (
              <div className="grid grid-cols-4 gap-2 text-center text-xs tabular-nums">
                <div className="rounded-lg bg-[#080B18] border border-white/10 py-2 px-2">
                  <span className="block text-[11px] text-slate-400">Pending</span>
                  <span className="font-mono text-slate-200">{pendingCount}</span>
                </div>
                <div className="rounded-lg bg-[#080B18] border border-violet-500/25 py-2 px-2">
                  <span className="block text-[11px] text-violet-300">Processing</span>
                  <span className="font-mono text-violet-200">{processingCount}</span>
                </div>
                <div className="rounded-lg bg-[#080B18] border border-emerald-500/25 py-2 px-2">
                  <span className="block text-[11px] text-emerald-300">Completed</span>
                  <span className="font-mono text-emerald-200">{completedCount}</span>
                </div>
                <div className="rounded-lg bg-[#080B18] border border-rose-500/25 py-2 px-2">
                  <span className="block text-[11px] text-rose-300">Failed</span>
                  <span className="font-mono text-rose-200">{failedCount}</span>
                </div>
              </div>
            )}

            {movie.chunkStates.length === 0 ? (
              <p className="text-xs text-slate-400">
                Chunk breakdown appears once audio extraction and segmentation begin.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-72 overflow-y-auto pr-1">
                {movie.chunkStates.map((chunk) => (
                  <div
                    key={chunk.index}
                    title={chunk.error || undefined}
                    className={`px-3 py-2 rounded-lg border text-xs tabular-nums ${
                      chunk.status === 'completed'
                        ? 'bg-emerald-950/30 border-emerald-500/25 text-emerald-200'
                        : chunk.status === 'processing'
                          ? 'bg-violet-950/40 border-violet-500/40 text-violet-200'
                          : chunk.status === 'failed'
                            ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                            : 'bg-[#080B18] border-white/10 text-slate-400'
                    }`}
                  >
                    <div className="flex items-center justify-between font-mono">
                      <span>Chunk {chunk.index + 1}</span>
                      <span className="capitalize">{chunk.status}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] opacity-80 mt-0.5 font-mono">
                      <span>
                        {Math.floor(chunk.startSec)}s–{Math.floor(chunk.endSec)}s
                      </span>
                      {chunk.attempts > 0 && <span>try {chunk.attempts}/5</span>}
                    </div>
                    {chunk.status === 'failed' && chunk.error && (
                      <p className="mt-1 text-[10px] text-rose-200/90 line-clamp-2 leading-snug">
                        {chunk.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Processing Logs */}
          <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-3">
            <h2 className="text-base font-semibold text-white">Processing Logs</h2>
            <div className="bg-[#080B18] border border-white/10 rounded-lg p-3.5 h-64 overflow-y-auto space-y-2 font-mono text-xs">
              {movie.logs.length === 0 ? (
                <p className="text-slate-500">No logs recorded yet.</p>
              ) : (
                movie.logs.map((entry) => (
                  <div key={entry.id} className="leading-relaxed">
                    <span className="text-slate-500 tabular-nums">
                      [{new Date(entry.createdAt).toLocaleTimeString()}]
                    </span>{' '}
                    <span
                      className={
                        entry.level === 'error'
                          ? 'text-rose-400'
                          : entry.level === 'warn'
                            ? 'text-amber-300'
                            : entry.level === 'success'
                              ? 'text-emerald-400'
                              : 'text-violet-300'
                      }
                    >
                      {entry.stage}:
                    </span>{' '}
                    <span className="text-slate-200">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
