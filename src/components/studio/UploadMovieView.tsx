import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Film,
  Play,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  createSampleTurkishMovie,
  startDubbingJob,
  uploadMovieResumable,
  type UploadProgressInfo,
} from '../../lib/api';
import type { MovieProject, ProviderHealth } from '../../types/studio';

interface UploadMovieViewProps {
  health: ProviderHealth | null;
  onMovieCreated: (movie: MovieProject, nextTab: 'characters' | 'processing') => void;
}

export function UploadMovieView({ health, onMovieCreated }: UploadMovieViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rightsBoxRef = useRef<HTMLLabelElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localDurationSec, setLocalDurationSec] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [rightsHighlighted, setRightsHighlighted] = useState(false);
  const [confirmLongMovie, setConfirmLongMovie] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressInfo | null>(null);
  const [creatingSample, setCreatingSample] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxUploadGb = health?.limits.maxUploadGb ?? 10;
  const maxDurationMin = health?.limits.maxDurationMinutes ?? 180;
  const shortClipMin = health?.limits.shortClipTestMinutes ?? 10;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function validateAndSelectFile(file: File) {
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp4', 'mov', 'mkv'].includes(ext)) {
      setError('Unsupported file type. Please select an MP4, MOV, or MKV movie file.');
      return;
    }
    const maxBytes = maxUploadGb * 1024 * 1024 * 1024;
    if (file.size > maxBytes) {
      setError(`File size exceeds the configured ${maxUploadGb} GB storage limit.`);
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setSelectedFile(file);
    setPreviewUrl(url);
    setTitle(file.name.replace(/\.[^.]+$/, ''));
    setLocalDurationSec(null);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) validateAndSelectFile(file);
  }

  async function handleUploadAndStart(action: 'scan' | 'full' | 'demo') {
    if (!selectedFile) {
      setError('Please select a Turkish movie file (MP4, MOV, or MKV).');
      return;
    }
    if (!rightsConfirmed) {
      setRightsHighlighted(true);
      setError('You must confirm ownership or explicit dubbing permission before uploading.');
      rightsBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (localDurationSec !== null && localDurationSec > maxDurationMin * 60) {
      setError(`Video duration exceeds the ${maxDurationMin}-minute maximum limit.`);
      return;
    }

    setError(null);
    setUploading(true);
    setUploadProgress({ uploadedBytes: 0, totalBytes: selectedFile.size, percent: 0, mbPerSec: 0 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const movie = await uploadMovieResumable({
        file: selectedFile,
        title: title.trim() || selectedFile.name,
        rightsConfirmed: true,
        onProgress: setUploadProgress,
        signal: controller.signal,
      });

      const started = await startDubbingJob(movie.id, {
        mode: action === 'scan' ? 'scan' : 'full',
        demoMode: action === 'demo',
        confirmLongMovie: confirmLongMovie || movie.durationSeconds <= shortClipMin * 60,
      });

      onMovieCreated(started, action === 'scan' ? 'processing' : 'processing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload or pipeline initialization failed.');
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  }

  async function handleGenerateTurkishSample() {
    setError(null);
    setCreatingSample(true);
    try {
      const sampleMovie = await createSampleTurkishMovie();
      onMovieCreated(sampleMovie, 'processing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create Turkish test clip.');
    } finally {
      setCreatingSample(false);
    }
  }

  const fileSizeMb = selectedFile ? (selectedFile.size / (1024 * 1024)).toFixed(2) : null;
  const isLongVideo =
    localDurationSec !== null && localDurationSec > shortClipMin * 60;

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Upload Turkish Movie</h1>
          <p className="text-sm text-slate-300">
            Resumable binary chunked upload up to {maxDurationMin} minutes ({maxUploadGb} GB storage cap).
          </p>
        </div>

        <button
          type="button"
          disabled={creatingSample || uploading || !health?.geminiConfigured}
          onClick={handleGenerateTurkishSample}
          title={
            health?.geminiConfigured
              ? 'Synthesize a real 12-second Turkish two-speaker MP4 test clip to verify the pipeline'
              : 'Configure GEMINI_API_KEY on the server to synthesize a Turkish test clip'
          }
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-500/35 bg-violet-950/30 hover:bg-violet-900/40 text-violet-200 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-45 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {creatingSample ? 'Generating Turkish Clip...' : 'Create 12s Turkish Test Clip'}
        </button>
      </div>

      {!health?.geminiConfigured && (
        <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/30 flex items-start gap-3 text-sm text-amber-100">
          <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">Gemini API Key Not Configured</p>
            <p className="text-xs text-amber-200/80 leading-relaxed">
              Live Turkish transcription, translation, and Pakistani Urdu TTS require{' '}
              <code className="font-mono">GEMINI_API_KEY</code> on the server. Without it, you can
              upload and preview files or explicitly run the clearly labeled Demo Mode workflow.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/30 flex items-start gap-3 text-sm text-rose-200">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left: Dropzone & Configuration */}
        <div className="lg:col-span-7 space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors cursor-pointer ${
              dragActive
                ? 'border-violet-400 bg-violet-950/30'
                : 'border-white/15 bg-[#0F1429] hover:border-violet-500/50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) validateAndSelectFile(file);
              }}
            />

            <div className="mx-auto w-12 h-12 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-300 mb-4">
              <UploadCloud className="w-6 h-6" />
            </div>

            {selectedFile ? (
              <div className="space-y-1.5">
                <p className="text-base font-medium text-white truncate max-w-md mx-auto">
                  {selectedFile.name}
                </p>
                <p className="text-xs text-slate-400 tabular-nums">
                  {fileSizeMb} MB
                  {localDurationSec !== null
                    ? ` · ${(localDurationSec / 60).toFixed(1)} min`
                    : ' · Inspecting metadata'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-base font-medium text-white">
                  Drop Turkish movie file here or browse
                </p>
                <p className="text-xs text-slate-400">
                  MP4, MOV, or MKV · Maximum {maxDurationMin} minutes · Up to {maxUploadGb} GB
                </p>
              </div>
            )}
          </div>

          <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="movie-title" className="block text-xs font-medium text-slate-300">
                Project Title
              </label>
              <input
                id="movie-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter movie or episode title"
                disabled={uploading}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Source Language</label>
                <select
                  value="tr"
                  disabled
                  aria-label="Source language"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B18] border border-white/10 text-sm text-slate-200"
                >
                  <option value="tr">Turkish (tr-TR)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Target Language</label>
                <select
                  value="ur-PK"
                  disabled
                  aria-label="Target language"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B18] border border-white/10 text-sm text-slate-200"
                >
                  <option value="ur-PK">Urdu — Pakistan (ur-PK)</option>
                </select>
              </div>
            </div>

            <label
              ref={rightsBoxRef}
              className={`flex items-start gap-3 text-xs leading-relaxed cursor-pointer p-3.5 rounded-lg border transition-colors ${
                rightsHighlighted && !rightsConfirmed
                  ? 'bg-rose-950/40 border-rose-500/60 text-rose-100 ring-1 ring-rose-500/40'
                  : rightsConfirmed
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-slate-200'
                    : 'bg-[#080B18] border-white/15 text-slate-200 hover:border-violet-500/40'
              }`}
            >
              <input
                type="checkbox"
                checked={rightsConfirmed}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setRightsConfirmed(checked);
                  if (checked) {
                    setRightsHighlighted(false);
                    if (
                      error ===
                      'You must confirm ownership or explicit dubbing permission before uploading.'
                    ) {
                      setError(null);
                    }
                  }
                }}
                disabled={uploading}
                className="mt-0.5 h-4 w-4 rounded border-white/25 bg-[#080B18] text-violet-600 focus:ring-violet-500 shrink-0"
              />
              <span className="space-y-1">
                <span className="block font-medium text-white">
                  Required: Confirm ownership or legal dubbing permission
                </span>
                <span className="block text-slate-300">
                  I confirm that I own this video or hold explicit legal authorization to translate
                  and dub its dialogue into Urdu.
                </span>
                {rightsHighlighted && !rightsConfirmed && (
                  <span className="block text-rose-300 font-medium pt-0.5">
                    Please tick this checkbox before clicking Upload.
                  </span>
                )}
              </span>
            </label>

            {isLongVideo && (
              <label className="flex items-start gap-3 text-xs text-amber-200 leading-relaxed p-3 rounded-lg bg-amber-950/30 border border-amber-500/25 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmLongMovie}
                  onChange={(e) => setConfirmLongMovie(e.target.checked)}
                  disabled={uploading}
                  className="mt-0.5 rounded border-amber-400/40 bg-[#080B18] text-violet-600"
                />
                <span>
                  This video exceeds {shortClipMin} minutes. Confirm direct long-movie chunked
                  processing (recommended after testing a short clip).
                </span>
              </label>
            )}

            {uploading && uploadProgress && (
              <div className="space-y-2 pt-2 border-t border-white/10">
                <div className="flex items-center justify-between text-xs text-slate-300 tabular-nums">
                  <span>
                    Streaming chunks:{' '}
                    {(uploadProgress.uploadedBytes / (1024 * 1024)).toFixed(1)} /{' '}
                    {(uploadProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB (
                    {uploadProgress.mbPerSec} MB/s)
                  </span>
                  <span className="font-mono text-violet-300">{uploadProgress.percent}%</span>
                </div>
                <div className="h-2 rounded-full bg-[#080B18] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-all duration-150"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="inline-flex items-center gap-1.5 text-xs text-rose-300 hover:text-rose-200"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel Upload
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              {health?.geminiConfigured ? (
                <>
                  <button
                    type="button"
                    disabled={uploading || !selectedFile}
                    onClick={() => handleUploadAndStart('scan')}
                    className="px-4 py-2.5 rounded-lg border border-white/15 bg-[#080B18] hover:bg-white/5 text-slate-200 text-sm font-medium transition-colors disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    Upload &amp; Identify Speakers First
                  </button>
                  <button
                    type="button"
                    disabled={uploading || !selectedFile}
                    onClick={() => handleUploadAndStart('full')}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <Play className="w-4 h-4" />
                    Upload &amp; Start Full Dubbing
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={uploading || !selectedFile}
                  onClick={() => handleUploadAndStart('demo')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all disabled:opacity-45 cursor-pointer whitespace-nowrap"
                >
                  Upload &amp; Run Clearly Labeled Demo Mode
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right: Video Preview & Validation Checklist */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium text-slate-200">Movie Preview</span>
              <span>Local browser stream</span>
            </div>

            {previewUrl ? (
              <video
                src={previewUrl}
                controls
                onLoadedMetadata={(e) => {
                  const dur = e.currentTarget.duration;
                  if (Number.isFinite(dur)) setLocalDurationSec(dur);
                }}
                className="w-full aspect-video rounded-lg bg-black border border-white/10"
              />
            ) : (
              <div className="w-full aspect-video rounded-lg bg-[#080B18] border border-white/10 flex flex-col items-center justify-center text-slate-500 gap-2">
                <Film className="w-8 h-8 opacity-60" />
                <span className="text-xs">Select a movie file to preview</span>
              </div>
            )}

            <div className="pt-2 border-t border-white/10 space-y-2 text-xs text-slate-300">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Container validation</span>
                <span className="flex items-center gap-1.5">
                  {selectedFile ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Valid ({selectedFile.name.split('.').pop()?.toUpperCase()})</span>
                    </>
                  ) : (
                    <span className="text-slate-500">Waiting for file</span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between tabular-nums">
                <span className="text-slate-400">Duration limit</span>
                <span>
                  {localDurationSec !== null
                    ? `${(localDurationSec / 60).toFixed(1)} / ${maxDurationMin} min`
                    : `Max ${maxDurationMin} min`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Memory protection</span>
                <span>8 MB disk-streamed chunks</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
