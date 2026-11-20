import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Mic2,
  Play,
  RotateCcw,
} from 'lucide-react';
import { startDubbingJob } from '../../lib/api';
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

  const isActive =
    movie.status === 'processing' || movie.status === 'queued' || movie.status === 'scanning';

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

          {movie.status === 'failed' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => triggerJob('resume_chunks', movie.demoMode)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Retry Failed Chunks
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

      {movie.demoMode && (
        <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/30 text-xs text-amber-200 leading-relaxed">
          Demo Mode is active for this project because live AI keys were unavailable. Outputs
          generated in Demo Mode are clearly marked as sample previews and do not represent real
          Turkish-to-Urdu speech translation.
        </div>
      )}

      {(error || movie.error) && (
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
              <span>{movie.currentStage}</span>
            </p>
          </div>

          <div className="flex items-center gap-6 text-right tabular-nums">
            <div>
              <span className="block text-xs text-slate-400">Chunks</span>
              <span className="text-sm font-mono text-white">
                {movie.completedChunks} / {movie.totalChunks || 1}
              </span>
            </div>
            <div>
              <span className="block text-xs text-slate-400">Estimated Remaining</span>
              <span className="text-sm font-mono text-slate-200 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                {movie.status === 'completed'
                  ? 'Completed'
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
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Audio Chunk Segments</h2>
              <span className="text-xs text-slate-400 tabular-nums">
                {movie.chunkStates.length} total segment(s)
              </span>
            </div>

            {movie.chunkStates.length === 0 ? (
              <p className="text-xs text-slate-400">
                Chunk breakdown appears once audio extraction and segmentation begin.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-60 overflow-y-auto pr-1">
                {movie.chunkStates.map((chunk) => (
                  <div
                    key={chunk.index}
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
                    <div className="text-[11px] opacity-80 mt-0.5 font-mono">
                      {Math.floor(chunk.startSec)}s–{Math.floor(chunk.endSec)}s
                    </div>
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
