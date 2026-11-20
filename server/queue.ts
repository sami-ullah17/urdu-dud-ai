import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  OUTPUTS_DIR,
  WORK_DIR,
  appendMovieLog,
  getMovie,
  listRecoverableMovies,
  markUserShortClipVerified,
  updateMovie,
} from './store.ts';
import {
  PROCESSING_STAGES,
  type CharacterProfile,
  type ChunkState,
  type DialogueSegment,
  type MovieProject,
  URDU_VOICE_PROFILES,
} from './types.ts';
import {
  GeminiTurkishAsrDiarizationAdapter,
  GeminiUrduTranslationAdapter,
  GeminiUrduTtsAdapter,
  buildDemoSegmentsForDuration,
  pickVoiceProfileForSpeaker,
} from './providers/dubbingAdapters.ts';
import { hasGeminiKey, ProviderNotConfiguredError } from './providers/geminiClient.ts';
import {
  extractBackgroundBed,
  extractFullStereoAudio,
  fitSegmentTiming,
  generateSrtSubtitles,
  mixVoiceAndBackground,
  muxFinalMp4,
  probeVideo,
  renderMixedVoiceTrack,
  splitAudioIntoChunks,
} from './providers/ffmpegPipeline.ts';

export type JobMode = 'scan' | 'full' | 'resume_chunks';

interface QueuedJob {
  movieId: string;
  mode: JobMode;
  demoMode: boolean;
}

const activeQueue: QueuedJob[] = [];
const runningMovies = new Set<string>();
let isDraining = false;

const CHUNK_DURATION_SECONDS = Math.max(
  30,
  Number(process.env.CHUNK_DURATION_SECONDS ?? 120) || 120
);
const CHUNK_OVERLAP_SECONDS = Math.max(
  0,
  Number(process.env.CHUNK_OVERLAP_SECONDS ?? 4) || 4
);

function setStage(
  movieId: string,
  stageIndex: number,
  progressPercent: number,
  etaSeconds: number | null = null
) {
  const stageName = PROCESSING_STAGES[Math.min(PROCESSING_STAGES.length - 1, Math.max(0, stageIndex))];
  updateMovie(movieId, {
    currentStage: stageName,
    stageIndex,
    progressPercent: Math.min(100, Math.max(0, Math.round(progressPercent))),
    etaSeconds,
  });
}

function cleanupWorkDir(movieWorkDir: string) {
  try {
    if (fs.existsSync(movieWorkDir)) {
      fs.rmSync(movieWorkDir, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal cleanup
  }
}

export function enqueueDubbingJob(movieId: string, mode: JobMode, demoMode = false): void {
  if (runningMovies.has(movieId)) {
    return;
  }
  const existingIdx = activeQueue.findIndex((j) => j.movieId === movieId);
  if (existingIdx >= 0) {
    activeQueue[existingIdx] = { movieId, mode, demoMode };
  } else {
    activeQueue.push({ movieId, mode, demoMode });
  }
  updateMovie(movieId, {
    status: mode === 'scan' ? 'scanning' : 'queued',
    error: undefined,
    demoMode,
  });
  appendMovieLog(
    movieId,
    'System',
    'info',
    `Job queued (mode=${mode}${demoMode ? ', DEMO_MODE' : ''}).`
  );
  void drainQueue();
}

export function resumePendingJobsOnStartup(): void {
  const interrupted = listRecoverableMovies();
  for (const movie of interrupted) {
    appendMovieLog(
      movie.id,
      'System',
      'warn',
      'Server restarted while job was active; resuming persisted dubbing job.'
    );
    enqueueDubbingJob(movie.id, movie.status === 'scanning' ? 'scan' : 'resume_chunks', movie.demoMode);
  }
}

async function drainQueue(): Promise<void> {
  if (isDraining) return;
  isDraining = true;
  try {
    while (activeQueue.length > 0) {
      const next = activeQueue.shift()!;
      if (runningMovies.has(next.movieId)) continue;
      runningMovies.add(next.movieId);
      try {
        await executeDubbingJob(next.movieId, next.mode, next.demoMode);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateMovie(next.movieId, {
          status: 'failed',
          error: msg,
          etaSeconds: null,
        });
        appendMovieLog(next.movieId, 'System', 'error', `Job failed: ${msg}`);
      } finally {
        runningMovies.delete(next.movieId);
      }
    }
  } finally {
    isDraining = false;
  }
}

function mergeSpeakerIntoRoster(
  movie: MovieProject,
  roster: CharacterProfile[],
  line: {
    speakerLabel: string;
    gender: CharacterProfile['gender'];
    genderConfidence: number;
    turkishText: string;
    urduText?: string;
  }
): CharacterProfile {
  const existing = roster.find(
    (c) => c.speakerLabel.toLowerCase() === line.speakerLabel.toLowerCase()
  );
  if (existing) {
    existing.lineCount += 1;
    if (!existing.sampleTurkish && line.turkishText) {
      existing.sampleTurkish = line.turkishText.slice(0, 240);
    }
    if (!existing.sampleUrdu && line.urduText) {
      existing.sampleUrdu = line.urduText.slice(0, 240);
    }
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  const usedVoiceIds = new Set(roster.map((c) => c.voiceProfileId));
  const assignedVoice = pickVoiceProfileForSpeaker(
    line.gender,
    line.genderConfidence,
    usedVoiceIds
  );

  const created: CharacterProfile = {
    id: `char_${crypto.randomUUID().slice(0, 8)}`,
    movieId: movie.id,
    ownerId: movie.ownerId,
    speakerLabel: line.speakerLabel,
    characterName: line.speakerLabel,
    gender: line.gender,
    genderConfidence: line.genderConfidence,
    voiceProfileId: assignedVoice,
    lineCount: 1,
    sampleTurkish: line.turkishText.slice(0, 240),
    sampleUrdu: (line.urduText ?? '').slice(0, 240),
    updatedAt: new Date().toISOString(),
  };
  roster.push(created);
  return created;
}

async function executeDubbingJob(
  movieId: string,
  mode: JobMode,
  demoMode: boolean
): Promise<void> {
  const movie = getMovie(movieId);
  if (!movie) return;

  if (!movie.rightsConfirmed) {
    throw new Error('Copyright permission confirmation is required before processing.');
  }

  if (!demoMode && !hasGeminiKey()) {
    throw new ProviderNotConfiguredError(
      'GEMINI_API_KEY is missing on the server. Configure GEMINI_API_KEY in Settings > Secrets, or explicitly start in clearly labeled Demo Mode.'
    );
  }

  const movieWorkDir = path.join(WORK_DIR, movieId);
  const chunksDir = path.join(movieWorkDir, 'chunks');
  const ttsDir = path.join(movieWorkDir, 'tts');
  fs.mkdirSync(movieWorkDir, { recursive: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(ttsDir, { recursive: true });

  const startedAt = movie.processingStartedAt ?? new Date().toISOString();
  updateMovie(movieId, {
    status: mode === 'scan' ? 'scanning' : 'processing',
    processingStartedAt: startedAt,
    error: undefined,
    demoMode,
  });

  // Probe video metadata
  const probe = await probeVideo(movie.sourceVideoPath);
  if (!probe.hasVideo || !probe.hasAudio) {
    throw new Error('Uploaded file must contain both a valid video stream and an audio stream.');
  }
  if (probe.durationSeconds > 180 * 60) {
    throw new Error(
      `Video duration (${(probe.durationSeconds / 60).toFixed(1)} min) exceeds the 180-minute limit.`
    );
  }

  // Stage 2: Extracting audio
  setStage(movieId, 1, 8, null);
  appendMovieLog(movieId, 'Extracting audio', 'info', 'Extracting 48kHz stereo audio track via FFmpeg.');
  const fullStereoWav = path.join(movieWorkDir, 'full_stereo.wav');
  await extractFullStereoAudio(movie.sourceVideoPath, fullStereoWav);

  // Stage 3: Detecting Turkish speech & splitting into manageable overlapping chunks
  setStage(movieId, 2, 14, null);
  const chunks = await splitAudioIntoChunks(
    fullStereoWav,
    chunksDir,
    probe.durationSeconds,
    CHUNK_DURATION_SECONDS,
    CHUNK_OVERLAP_SECONDS
  );

  // Preserve existing chunk state when resuming failed chunks
  const prevChunkMap = new Map(movie.chunkStates.map((c) => [c.index, c]));
  const chunkStates: ChunkState[] = chunks.map((ch) => {
    const prev = prevChunkMap.get(ch.index);
    if (mode === 'resume_chunks' && prev && prev.status === 'completed') {
      return prev;
    }
    return {
      index: ch.index,
      startSec: ch.startSec,
      endSec: ch.endSec,
      status: 'pending',
      attempts: prev?.attempts ?? 0,
    };
  });

  updateMovie(movieId, {
    totalChunks: chunks.length,
    completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
    failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
    chunkStates,
  });

  appendMovieLog(
    movieId,
    'Detecting Turkish speech',
    'info',
    `Split ${probe.durationSeconds.toFixed(1)}s audio into ${chunks.length} overlapping segment(s) (${CHUNK_DURATION_SECONDS}s window, ${CHUNK_OVERLAP_SECONDS}s overlap).`
  );

  // Clearly labeled Demo Mode pipeline (only when user explicitly selects Demo Mode because API key is missing)
  if (demoMode) {
    setStage(movieId, 3, 40, 6);
    appendMovieLog(
      movieId,
      'Transcribing dialogue',
      'warn',
      'DEMO MODE ACTIVE: Using clearly labeled sample dialogue transcript (no real Turkish ASR performed).'
    );
    const demoSegs = buildDemoSegmentsForDuration(probe.durationSeconds);
    const roster: CharacterProfile[] = [...movie.characters];
    for (const seg of demoSegs) {
      const char = mergeSpeakerIntoRoster(movie, roster, seg);
      seg.voiceProfileId = char.voiceProfileId;
    }

    setStage(movieId, 7, 72, 3);
    // Generate clean ambient synth tone bed + silence-matched MP4 in demo mode
    const bgBedWav = path.join(movieWorkDir, 'bg_bed.wav');
    await extractBackgroundBed(fullStereoWav, bgBedWav, probe.channels ?? 2);
    const outMp4 = path.join(OUTPUTS_DIR, `${movieId}_demo_dubbed.mp4`);
    const outSrt = path.join(OUTPUTS_DIR, `${movieId}_demo_urdu.srt`);

    setStage(movieId, 9, 92, 1);
    await muxFinalMp4(movie.sourceVideoPath, bgBedWav, outMp4);
    generateSrtSubtitles(demoSegs, outSrt);

    const mp4Stat = fs.statSync(outMp4);
    updateMovie(movieId, {
      status: 'completed',
      currentStage: 'Rendering final MP4',
      stageIndex: 9,
      progressPercent: 100,
      etaSeconds: 0,
      completedChunks: chunks.length,
      failedChunks: 0,
      chunkStates: chunkStates.map((c) => ({ ...c, status: 'completed' })),
      characters: roster,
      segments: demoSegs,
      outputMp4Path: outMp4,
      outputMp4SizeBytes: mp4Stat.size,
      outputSrtPath: outSrt,
      sourceSeparationMethod: 'Demo Mode — FFmpeg background stem preview',
      processingCompletedAt: new Date().toISOString(),
    });
    appendMovieLog(movieId, 'Rendering final MP4', 'success', 'Demo Mode preview MP4 and SRT exported.');
    cleanupWorkDir(movieWorkDir);
    return;
  }

  // Real AI Pipeline
  const asrAdapter = new GeminiTurkishAsrDiarizationAdapter();
  const translationAdapter = new GeminiUrduTranslationAdapter();
  const ttsAdapter = new GeminiUrduTtsAdapter();

  const roster: CharacterProfile[] = movie.characters.map((c) => ({ ...c, lineCount: 0 }));
  const existingSegmentsByChunk = new Map<number, DialogueSegment[]>();
  if (mode === 'resume_chunks') {
    for (const seg of movie.segments) {
      const arr = existingSegmentsByChunk.get(seg.chunkIndex) ?? [];
      arr.push(seg);
      existingSegmentsByChunk.set(seg.chunkIndex, arr);
    }
  }

  const allSegments: DialogueSegment[] = [];
  const chunkDurationsMs: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const state = chunkStates[i];

    if (mode === 'resume_chunks' && state.status === 'completed' && existingSegmentsByChunk.has(i)) {
      const preserved = existingSegmentsByChunk.get(i)!;
      for (const seg of preserved) {
        const char = mergeSpeakerIntoRoster(movie, roster, seg);
        seg.voiceProfileId = char.voiceProfileId;
        allSegments.push(seg);
      }
      continue;
    }

    state.status = 'processing';
    updateMovie(movieId, { chunkStates: [...chunkStates] });

    const chunkStartMs = Date.now();
    let chunkSucceeded = false;
    let lastChunkErr = '';

    // Automatic chunk-level retry loop (up to 3 attempts)
    for (let attempt = 1; attempt <= 3; attempt++) {
      state.attempts = attempt;
      try {
        // Real ETA calculated ONLY after >=1 chunk completes
        const avgChunkMs =
          chunkDurationsMs.length > 0
            ? chunkDurationsMs.reduce((a, b) => a + b, 0) / chunkDurationsMs.length
            : null;
        const remainingChunks = chunks.length - i;
        const etaSec =
          avgChunkMs !== null ? Math.round((avgChunkMs * remainingChunks) / 1000) + 12 : null;

        // Stage 4: Transcribing dialogue + Stage 5: Identifying speakers
        const basePct = 18 + (i / chunks.length) * 52;
        setStage(movieId, 3, basePct, etaSec);

        const diarizedLines = await asrAdapter.transcribeAndDiarizeChunk({
          chunkAudioPath: chunk.audioPath,
          chunkIndex: i,
          chunkStartSec: chunk.startSec,
          chunkEndSec: chunk.endSec,
          knownCharacters: roster,
        });

        setStage(movieId, 4, basePct + 6 / chunks.length, etaSec);

        // Deduplicate lines captured inside overlap region from previous chunk
        const lastPrevEnd =
          allSegments.length > 0 ? allSegments[allSegments.length - 1].endSec : -1;
        const freshLines = diarizedLines.filter(
          (l) => i === 0 || l.startSec >= lastPrevEnd - 0.35
        );

        // Stage 6: Translating Turkish into Urdu (only if full mode or for sample preview)
        setStage(movieId, 5, basePct + 14 / chunks.length, etaSec);
        const translations =
          freshLines.length > 0
            ? await translationAdapter.translateBatch({
                movieTitle: movie.title,
                lines: freshLines.map((l, idx) => ({
                  index: idx,
                  speakerLabel: l.speakerLabel,
                  gender: l.gender,
                  turkishText: l.turkishText,
                  emotion: l.emotion,
                  durationSec: Math.max(0.8, l.endSec - l.startSec),
                })),
              })
            : [];

        const translationMap = new Map(translations.map((t) => [t.index, t.urduText]));

        for (let idx = 0; idx < freshLines.length; idx++) {
          const line = freshLines[idx];
          const urduText = translationMap.get(idx) || line.turkishText;
          const char = mergeSpeakerIntoRoster(movie, roster, {
            speakerLabel: line.speakerLabel,
            gender: line.gender,
            genderConfidence: line.genderConfidence,
            turkishText: line.turkishText,
            urduText,
          });

          allSegments.push({
            id: `seg_${i}_${idx}`,
            chunkIndex: i,
            startSec: line.startSec,
            endSec: line.endSec,
            speakerId: char.id,
            speakerLabel: char.speakerLabel,
            gender: char.gender,
            genderConfidence: char.genderConfidence,
            turkishText: line.turkishText,
            urduText,
            emotion: line.emotion,
            voiceProfileId: char.voiceProfileId,
          });
        }

        const elapsed = Date.now() - chunkStartMs;
        chunkDurationsMs.push(elapsed);
        state.status = 'completed';
        state.durationMs = elapsed;
        state.error = undefined;
        chunkSucceeded = true;
        appendMovieLog(
          movieId,
          'Translating Turkish into Urdu',
          'info',
          `Chunk ${i + 1}/${chunks.length} complete (${freshLines.length} dialogue lines, ${(elapsed / 1000).toFixed(1)}s).`
        );
        break;
      } catch (err) {
        lastChunkErr = err instanceof Error ? err.message : String(err);
        appendMovieLog(
          movieId,
          'Transcribing dialogue',
          'warn',
          `Chunk ${i + 1}/${chunks.length} attempt ${attempt} failed: ${lastChunkErr}`
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }

    if (!chunkSucceeded) {
      state.status = 'failed';
      state.error = lastChunkErr;
      updateMovie(movieId, {
        chunkStates: [...chunkStates],
        completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
        failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
        characters: roster,
        segments: allSegments,
      });
      throw new Error(`Chunk ${i + 1} failed after 3 attempts: ${lastChunkErr}`);
    }

    updateMovie(movieId, {
      chunkStates: [...chunkStates],
      completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
      failedChunks: 0,
      characters: roster,
      segments: allSegments,
    });
  }

  // If user requested speaker discovery scan only, stop cleanly so they can customize character voices
  if (mode === 'scan') {
    updateMovie(movieId, {
      status: 'ready_for_dubbing',
      currentStage: 'Identifying speakers',
      stageIndex: 4,
      progressPercent: 50,
      etaSeconds: null,
      characters: roster,
      segments: allSegments,
    });
    appendMovieLog(
      movieId,
      'Identifying speakers',
      'success',
      `Speaker scan complete: identified ${roster.length} character(s) across ${allSegments.length} dialogue lines. Ready for voice review.`
    );
    cleanupWorkDir(movieWorkDir);
    return;
  }

  // Re-apply latest user-edited character voice locks before generating Urdu TTS!
  const refreshedMovie = getMovie(movieId);
  const lockedRoster = refreshedMovie?.characters.length ? refreshedMovie.characters : roster;
  const lockedMap = new Map(lockedRoster.map((c) => [c.speakerLabel, c]));
  for (const seg of allSegments) {
    const locked = lockedMap.get(seg.speakerLabel);
    if (locked) {
      seg.voiceProfileId = locked.voiceProfileId;
      seg.gender = locked.gender;
    }
  }

  // Stage 7: Generating Urdu voices + Stage 8: Synchronizing dialogue
  setStage(movieId, 6, 72, null);
  appendMovieLog(
    movieId,
    'Generating Urdu voices',
    'info',
    `Synthesizing ${allSegments.length} Pakistani Urdu dialogue tracks with consistent character voices.`
  );

  const ttsDurations: number[] = [];
  for (let idx = 0; idx < allSegments.length; idx++) {
    const seg = allSegments[idx];
    const t0 = Date.now();
    const voiceProfile =
      URDU_VOICE_PROFILES.find((v) => v.id === seg.voiceProfileId) ?? URDU_VOICE_PROFILES[0];

    const rawWav = path.join(ttsDir, `raw_${idx}.wav`);
    const timedWav = path.join(ttsDir, `timed_${idx}.wav`);

    await ttsAdapter.synthesizeLine({
      urduText: seg.urduText,
      emotion: seg.emotion,
      voiceProfile,
      outWavPath: rawWav,
    });

    setStage(movieId, 7, 72 + ((idx + 1) / Math.max(1, allSegments.length)) * 16);
    await fitSegmentTiming(
      rawWav,
      timedWav,
      Math.max(0.6, seg.endSec - seg.startSec),
      voiceProfile.pitchSemitones
    );
    seg.timedWavPath = timedWav;
    ttsDurations.push(Date.now() - t0);

    if ((idx + 1) % 5 === 0 || idx === allSegments.length - 1) {
      const avgTtsMs = ttsDurations.reduce((a, b) => a + b, 0) / ttsDurations.length;
      const eta = Math.round(((allSegments.length - idx - 1) * avgTtsMs) / 1000) + 8;
      updateMovie(movieId, {
        progressPercent: Math.round(72 + ((idx + 1) / Math.max(1, allSegments.length)) * 16),
        etaSeconds: eta,
      });
    }
  }

  // Stage 9: Mixing audio (source separation / SFX preservation + sidechain ducking)
  setStage(movieId, 8, 90, 6);
  const sepUrl = process.env.SOURCE_SEPARATION_URL?.trim();
  const sepMethod = sepUrl
    ? `External Stem Separator (${sepUrl})`
    : 'FFmpeg Mid-Side Dialogue Suppression + Sidechain Ducking';

  appendMovieLog(
    movieId,
    'Mixing audio',
    'info',
    `Isolating background music/SFX (${sepMethod}) and mixing ${allSegments.length} synchronized Urdu lines.`
  );

  const bgBedWav = path.join(movieWorkDir, 'bg_bed.wav');
  const voiceTrackWav = path.join(movieWorkDir, 'urdu_voices.wav');
  const masterAudioWav = path.join(movieWorkDir, 'master_audio.wav');

  await extractBackgroundBed(fullStereoWav, bgBedWav, probe.channels ?? 2);
  await renderMixedVoiceTrack(allSegments, probe.durationSeconds, movieWorkDir, voiceTrackWav);
  await mixVoiceAndBackground(bgBedWav, voiceTrackWav, masterAudioWav);

  // Stage 10: Rendering final MP4 & Urdu SRT
  setStage(movieId, 9, 96, 3);
  const outMp4Path = path.join(OUTPUTS_DIR, `${movieId}_urdu_dubbed.mp4`);
  const outSrtPath = path.join(OUTPUTS_DIR, `${movieId}_urdu.srt`);

  await muxFinalMp4(movie.sourceVideoPath, masterAudioWav, outMp4Path);
  generateSrtSubtitles(allSegments, outSrtPath);

  const mp4Stats = fs.statSync(outMp4Path);
  updateMovie(movieId, {
    status: 'completed',
    currentStage: 'Rendering final MP4',
    stageIndex: 9,
    progressPercent: 100,
    etaSeconds: 0,
    characters: lockedRoster,
    segments: allSegments.map((s) => ({
      ...s,
      ttsWavPath: undefined,
      timedWavPath: undefined,
    })),
    outputMp4Path: outMp4Path,
    outputMp4SizeBytes: mp4Stats.size,
    outputSrtPath: outSrtPath,
    sourceSeparationMethod: sepMethod,
    processingCompletedAt: new Date().toISOString(),
  });

  if (probe.durationSeconds <= 10 * 60) {
    markUserShortClipVerified(movie.ownerId);
  }

  appendMovieLog(
    movieId,
    'Rendering final MP4',
    'success',
    `Exported final Urdu dubbed MP4 (${(mp4Stats.size / (1024 * 1024)).toFixed(2)} MB) and synchronized Urdu SRT.`
  );

  cleanupWorkDir(movieWorkDir);
}
