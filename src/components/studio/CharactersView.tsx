import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Mic2,
  Play,
  RefreshCw,
  Save,
  Square,
  UserCheck,
} from 'lucide-react';
import { previewUrduVoice, saveMovieCharacters, startDubbingJob } from '../../lib/api';
import type {
  CharacterGender,
  CharacterProfile,
  MovieProject,
  UrduVoiceProfile,
} from '../../types/studio';

interface CharactersViewProps {
  movie: MovieProject | null;
  voices: UrduVoiceProfile[];
  onMovieUpdated: (movie: MovieProject) => void;
  onStartProcessing: () => void;
}

export function CharactersView({
  movie,
  voices,
  onMovieUpdated,
  onStartProcessing,
}: CharactersViewProps) {
  const [drafts, setDrafts] = useState<CharacterProfile[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setDrafts(movie?.characters ?? []);
    setSavedNotice(false);
    setError(null);
  }, [movie?.id, movie?.characters]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  if (!movie) {
    return (
      <div className="rounded-xl bg-[#0F1429] border border-white/10 p-10 text-center space-y-2">
        <Mic2 className="w-8 h-8 text-slate-500 mx-auto" />
        <h2 className="text-lg font-medium text-white">No Movie Selected</h2>
        <p className="text-sm text-slate-400">
          Select a project from the Dashboard or upload a Turkish film to manage character voices.
        </p>
      </div>
    );
  }

  function updateDraft(id: string, patch: Partial<CharacterProfile>) {
    setSavedNotice(false);
    setDrafts((prev) =>
      prev.map((char) => {
        if (char.id !== id) return char;
        const next = { ...char, ...patch };
        // If gender changed manually, ensure assigned voice matches the selected gender
        if (patch.gender && patch.gender !== 'unknown') {
          const currentVoice = voices.find((v) => v.id === next.voiceProfileId);
          if (currentVoice && currentVoice.gender !== patch.gender) {
            const firstMatch = voices.find((v) => v.gender === patch.gender);
            if (firstMatch) next.voiceProfileId = firstMatch.id;
          }
        }
        return next;
      })
    );
  }

  async function handlePreviewVoice(voiceProfileId: string, sampleUrdu?: string) {
    if (playingVoiceId === voiceProfileId) {
      audioRef.current?.pause();
      setPlayingVoiceId(null);
      return;
    }

    setError(null);
    setPreviewingVoiceId(voiceProfileId);
    try {
      const res = await previewUrduVoice(
        voiceProfileId,
        sampleUrdu && sampleUrdu.length > 4 ? sampleUrdu : undefined
      );
      audioRef.current?.pause();
      const audio = new Audio(`data:${res.mimeType};base64,${res.audioBase64}`);
      audioRef.current = audio;
      setPlayingVoiceId(voiceProfileId);
      audio.onended = () => setPlayingVoiceId(null);
      audio.onerror = () => setPlayingVoiceId(null);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate Urdu voice preview.');
    } finally {
      setPreviewingVoiceId(null);
    }
  }

  async function handleSaveCharacters(andStartDubbing: boolean) {
    if (!movie) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await saveMovieCharacters(movie.id, drafts);
      onMovieUpdated(updated);
      setSavedNotice(true);
      if (andStartDubbing) {
        const started = await startDubbingJob(movie.id, {
          mode: 'full',
          confirmLongMovie: true,
        });
        onMovieUpdated(started);
        onStartProcessing();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save character voice locks.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRunSpeakerScan() {
    if (!movie) return;
    setError(null);
    setSaving(true);
    try {
      const started = await startDubbingJob(movie.id, {
        mode: 'scan',
        confirmLongMovie: true,
      });
      onMovieUpdated(started);
      onStartProcessing();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start speaker identification.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Character Voice Management
          </h1>
          <p className="text-sm text-slate-300">
            {movie.title} · Lock one consistent Pakistani Urdu voice profile per speaker across the
            entire film.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving || movie.status === 'processing' || movie.status === 'scanning'}
            onClick={handleRunSpeakerScan}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/15 bg-[#0F1429] hover:bg-white/5 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-45 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Re-scan Speakers
          </button>

          {drafts.length > 0 && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => handleSaveCharacters(false)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-500/40 bg-violet-950/30 hover:bg-violet-900/40 text-violet-200 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-45 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                Save Voice Locks
              </button>

              <button
                type="button"
                disabled={saving || movie.status === 'processing'}
                onClick={() => handleSaveCharacters(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap disabled:opacity-45 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                Apply Voices &amp; Render Dubbed MP4
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/30 flex items-start gap-3 text-sm text-rose-200">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {savedNotice && (
        <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 flex items-center gap-2.5 text-sm text-emerald-200">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>
            Character voice assignments saved and locked across all {movie.segmentsCount} dialogue
            segments.
          </span>
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="rounded-xl bg-[#0F1429] border border-white/10 p-10 text-center space-y-4">
          <UserCheck className="w-9 h-9 text-violet-400 mx-auto" />
          <div className="space-y-1 max-w-md mx-auto">
            <h2 className="text-lg font-medium text-white">No Speakers Identified Yet</h2>
            <p className="text-sm text-slate-400">
              Run Speaker Identification to detect Turkish voices, estimate gender confidence, and
              assign consistent Pakistani Urdu voice profiles before rendering.
            </p>
          </div>
          <button
            type="button"
            disabled={saving || movie.status === 'scanning' || movie.status === 'processing'}
            onClick={handleRunSpeakerScan}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all disabled:opacity-45 cursor-pointer"
          >
            <Mic2 className="w-4 h-4" />
            Identify Speakers Now
          </button>
        </div>
      ) : (
        <div className="grid gap-5">
          {drafts.map((char) => {
            const confidencePct = Math.round(char.genderConfidence * 100);
            const lowConfidence = char.genderConfidence < 0.7 || char.gender === 'unknown';
            const selectedVoice =
              voices.find((v) => v.id === char.voiceProfileId) ?? voices[0];
            const isPreviewLoading = previewingVoiceId === char.voiceProfileId;
            const isPlaying = playingVoiceId === char.voiceProfileId;

            return (
              <div
                key={char.id}
                className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-5"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/10 pb-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono text-violet-300">{char.speakerLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{char.lineCount} dialogue lines</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={`tabular-nums ${
                          lowConfidence ? 'text-amber-300' : 'text-emerald-300'
                        }`}
                      >
                        {lowConfidence
                          ? `Gender confidence ${confidencePct}% — please verify`
                          : `Gender confidence ${confidencePct}%`}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isPreviewLoading}
                    onClick={() => handlePreviewVoice(char.voiceProfileId, char.sampleUrdu)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-white/15 bg-[#080B18] hover:bg-white/5 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap self-start lg:self-auto cursor-pointer"
                  >
                    {isPlaying ? (
                      <>
                        <Square className="w-3.5 h-3.5 text-violet-400" />
                        Stop Preview
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 text-violet-400" />
                        {isPreviewLoading ? 'Synthesizing...' : 'Preview Urdu Voice'}
                      </>
                    )}
                  </button>
                </div>

                <div className="grid sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-300">
                      Character Name
                    </label>
                    <input
                      type="text"
                      value={char.characterName}
                      onChange={(e) => updateDraft(char.id, { characterName: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white focus:outline-none focus:border-violet-500"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-300">
                      Character Gender
                    </label>
                    <select
                      value={char.gender}
                      onChange={(e) =>
                        updateDraft(char.id, {
                          gender: e.target.value as CharacterGender,
                          genderConfidence: 1,
                        })
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white focus:outline-none focus:border-violet-500"
                    >
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="unknown">Unknown / Unassigned</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-300">
                      Locked Pakistani Urdu Voice
                    </label>
                    <select
                      value={char.voiceProfileId}
                      onChange={(e) =>
                        updateDraft(char.id, { voiceProfileId: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white focus:outline-none focus:border-violet-500"
                    >
                      {voices.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {(char.sampleTurkish || char.sampleUrdu) && (
                  <div className="grid md:grid-cols-2 gap-4 pt-2 border-t border-white/10 text-xs">
                    <div className="space-y-1">
                      <span className="text-slate-400">Sample Turkish Line</span>
                      <p className="text-slate-200 leading-relaxed">
                        {char.sampleTurkish || '—'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-slate-400">Sample Pakistani Urdu Line</span>
                      <p className="font-urdu text-sm text-slate-100">
                        {char.sampleUrdu || '—'}
                      </p>
                    </div>
                  </div>
                )}

                {selectedVoice && (
                  <p className="text-xs text-slate-400">
                    Voice note: {selectedVoice.description}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
