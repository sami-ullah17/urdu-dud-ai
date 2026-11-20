import { useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  Film,
  Subtitles,
  Trash2,
} from 'lucide-react';
import { deleteMovieProject } from '../../lib/api';
import { deleteMovieFromFirestore } from '../../lib/firestoreSync';
import type { MovieProject } from '../../types/studio';

interface DownloadViewProps {
  movie: MovieProject | null;
  onDeleted: (deletedId: string) => void;
  onGoToProcessing: () => void;
}

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

export function DownloadView({ movie, onDeleted, onGoToProcessing }: DownloadViewProps) {
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!movie) {
    return (
      <div className="rounded-xl bg-[#0F1429] border border-white/10 p-10 text-center space-y-2">
        <Film className="w-8 h-8 text-slate-500 mx-auto" />
        <h2 className="text-lg font-medium text-white">No Project Selected</h2>
        <p className="text-sm text-slate-400">
          Select a completed movie from the Dashboard to preview and export MP4 and Urdu SRT files.
        </p>
      </div>
    );
  }

  async function handleConfirmDelete() {
    if (!movie) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteMovieProject(movie.id);
      await deleteMovieFromFirestore(movie.id).catch(() => {});
      setConfirmDeleteOpen(false);
      onDeleted(movie.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setDeleting(false);
    }
  }

  const mp4Ready = movie.status === 'completed' && Boolean(movie.downloadMp4Url);
  const mp4SizeMb = movie.outputMp4SizeBytes
    ? (movie.outputMp4SizeBytes / (1024 * 1024)).toFixed(2)
    : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Export &amp; Final Preview
          </h1>
          <p className="text-sm text-slate-300">
            {movie.title} · Synchronized Pakistani Urdu MP4 and UTF-8 SRT subtitles.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setConfirmDeleteOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-rose-500/35 bg-rose-950/30 hover:bg-rose-900/40 text-rose-200 text-xs font-medium transition-colors whitespace-nowrap self-start md:self-auto cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete Project
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/30 text-sm text-rose-200">
          {error}
        </div>
      )}

      {!mp4Ready ? (
        <div className="rounded-xl bg-[#0F1429] border border-white/10 p-10 text-center space-y-4">
          <Film className="w-9 h-9 text-violet-400 mx-auto" />
          <div className="space-y-1 max-w-md mx-auto">
            <h2 className="text-lg font-medium text-white">Final MP4 Not Rendered Yet</h2>
            <p className="text-sm text-slate-400">
              Current status: <span className="text-slate-200">{movie.status}</span> (
              {movie.currentStage}). Complete the dubbing pipeline to unlock MP4 and SRT exports.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoToProcessing}
            className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all cursor-pointer"
          >
            Open Processing Dashboard
          </button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left: Video Player & Downloads */}
          <div className="lg:col-span-7 space-y-6">
            <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-medium text-slate-200">
                  Final Dubbed Video Preview {movie.demoMode ? '(Demo Mode Preview)' : ''}
                </span>
                <span className="font-mono tabular-nums">
                  {movie.width && movie.height ? `${movie.width}x${movie.height} · ` : ''}
                  {mp4SizeMb ? `${mp4SizeMb} MB` : ''}
                </span>
              </div>

              <video
                src={movie.downloadMp4Url!}
                controls
                className="w-full aspect-video rounded-lg bg-black border border-white/10"
              />

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <a
                  href={`${movie.downloadMp4Url!}&download=1`}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  Download Dubbed MP4
                </a>

                {movie.downloadSrtUrl && (
                  <a
                    href={movie.downloadSrtUrl}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-white/15 bg-[#080B18] hover:bg-white/5 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap"
                  >
                    <Subtitles className="w-4 h-4 text-violet-400" />
                    Download Urdu Subtitles (SRT)
                  </a>
                )}
              </div>
            </div>

            {/* Bilingual Dialogue Transcript Preview */}
            <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-violet-400" />
                  Synchronized Urdu Subtitle &amp; Dialogue Script
                </h2>
                <span className="text-xs text-slate-400 tabular-nums">
                  {movie.segmentsCount} segments
                </span>
              </div>

              <div className="max-h-80 overflow-y-auto divide-y divide-white/10">
                {(movie.segments ?? []).length === 0 ? (
                  <p className="text-xs text-slate-400 py-4">
                    Subtitle segments are bundled in the downloadable SRT file.
                  </p>
                ) : (
                  (movie.segments ?? []).map((seg) => (
                    <div key={seg.id} className="py-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span className="font-mono text-violet-300">{seg.speakerLabel}</span>
                        <span className="font-mono tabular-nums">
                          {formatTimecode(seg.startSec)} → {formatTimecode(seg.endSec)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300">{seg.turkishText}</p>
                      <p className="font-urdu text-sm text-white">{seg.urduText}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: Processing Telemetry Summary */}
          <div className="lg:col-span-5">
            <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
              <h2 className="text-base font-semibold text-white">Processing Summary</h2>
              <dl className="divide-y divide-white/10 text-sm">
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-400">Source File</dt>
                  <dd className="text-slate-100 text-right truncate max-w-[220px]">
                    {movie.originalFilename}
                  </dd>
                </div>
                <div className="py-3 flex justify-between gap-4 tabular-nums">
                  <dt className="text-slate-400">Movie Duration</dt>
                  <dd className="text-slate-100 font-mono">
                    {(movie.durationSeconds / 60).toFixed(2)} min ({movie.durationSeconds.toFixed(1)}s)
                  </dd>
                </div>
                <div className="py-3 flex justify-between gap-4 tabular-nums">
                  <dt className="text-slate-400">Locked Characters</dt>
                  <dd className="text-slate-100 font-mono">{movie.characters.length}</dd>
                </div>
                <div className="py-3 flex justify-between gap-4 tabular-nums">
                  <dt className="text-slate-400">Dialogue Segments</dt>
                  <dd className="text-slate-100 font-mono">{movie.segmentsCount}</dd>
                </div>
                <div className="py-3 flex justify-between gap-4 tabular-nums">
                  <dt className="text-slate-400">Chunks Processed</dt>
                  <dd className="text-slate-100 font-mono">
                    {movie.completedChunks} / {movie.totalChunks}
                  </dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-400">Audio Bed Method</dt>
                  <dd className="text-slate-100 text-right text-xs max-w-[240px]">
                    {movie.sourceSeparationMethod || 'FFmpeg Sidechain Ducking'}
                  </dd>
                </div>
                <div className="py-3 flex justify-between gap-4 tabular-nums">
                  <dt className="text-slate-400">Output MP4 Size</dt>
                  <dd className="text-slate-100 font-mono">{mp4SizeMb ? `${mp4SizeMb} MB` : '—'}</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      )}

      {/* In-app Deletion Confirmation Dialog */}
      {confirmDeleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#050814]/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-lg font-semibold text-white">Delete Project Files?</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  This permanently removes "{movie.title}", the source Turkish video, the rendered
                  Urdu MP4, and the SRT subtitle file from storage.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmDeleteOpen(false)}
                className="px-4 py-2 rounded-lg border border-white/15 bg-[#080B18] text-slate-200 text-sm font-medium hover:bg-white/5 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium cursor-pointer disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
