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
  deduplicateBoundaryLines,
  pickVoiceProfileForSpeaker,
} from './providers/dubbingAdapters.ts';
import {
  classifyGeminiError,
  hasGeminiKey,
  JobCancelledError,
  ProviderNotConfiguredError,
  QuotaExhaustedError,
  sleepWithCancel,
} from './providers/geminiClient.ts';
import {
  extractBackgroundBed,
  extractFullStereoAudio,
  extractSingleChunkAudio,
  fitSegmentTiming,
  generateSrtSubtitles,
  mixVoiceAndBackground,
  muxFinalMp4,
  probeVideo,
  renderMixedVoiceTrack,
  splitAudioIntoChunks,
  type ExtractedChunk,
} from './providers/ffmpegPipeline.ts';

export type JobMode = 'scan' | 'full' | 'resume_chunks';

interface QueuedJob {
  movieId: string;
  mode: JobMode;
  demoMode: boolean;
}

const activeQueue: QueuedJob[] = [];
const runningMovies = new Set<string>();
const cancelledMovies = new Set<string>();
let isDraining = false;

// 60-120s chunks with 5-10s overlap (defaults: 90s chunk, 6s overlap)
const rawChunkDuration = Number(process.env.CHUNK_DURATION_SECONDS ?? 90) || 90;
const CHUNK_DURATION_SECONDS = Math.min(120, Math.max(60, rawChunkDuration));

const rawChunkOverlap = Number(process.env.CHUNK_OVERLAP_SECONDS ?? 6) || 6;
const CHUNK_OVERLAP_SECONDS = Math.min(10, Math.max(5, rawChunkOverlap));

const MAX_CHUNK_ATTEMPTS = 5;

function isJobCancelled(movieId: string): boolean {
  return cancelledMovies.has(movieId);
}

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

export function computeTtsChunkCounts(segments: DialogueSegment[]) {
  const totalTtsChunks = segments.length;
  const completedTtsChunks = segments.filter((s) => s.ttsStatus === 'completed').length;
  const failedTtsChunks = segments.filter((s) => s.ttsStatus === 'failed').length;
  const remainingTtsChunks = Math.max(0, totalTtsChunks - completedTtsChunks);
  return {
    totalTtsChunks,
    completedTtsChunks,
    failedTtsChunks,
    remainingTtsChunks,
  };
}

function revertProcessingStatesToPending(
  chunkStates: ChunkState[],
  segments: DialogueSegment[]
) {
  for (const ch of chunkStates) {
    if (ch.status === 'processing') {
      ch.status = 'pending';
    }
  }
  for (const seg of segments) {
    if (seg.ttsStatus === 'processing') {
      seg.ttsStatus = 'pending';
    }
  }
}

export function enqueueDubbingJob(movieId: string, mode: JobMode, demoMode = false): void {
  cancelledMovies.delete(movieId);

  if (runningMovies.has(movieId)) {
    return;
  }
  const existing = getMovie(movieId);
  const resolvedTargetMode: 'scan' | 'full' =
    mode === 'scan'
      ? 'scan'
      : mode === 'full'
        ? 'full'
        : existing?.targetMode ?? 'full';

  const existingIdx = activeQueue.findIndex((j) => j.movieId === movieId);
  if (existingIdx >= 0) {
    activeQueue[existingIdx] = { movieId, mode, demoMode };
  } else {
    activeQueue.push({ movieId, mode, demoMode });
  }
  updateMovie(movieId, {
    status: mode === 'scan' ? 'scanning' : 'queued',
    targetMode: resolvedTargetMode,
    pauseReason: undefined,
    pausedAt: undefined,
    quotaResetAt: undefined,
    error: undefined,
    demoMode,
  });
  appendMovieLog(
    movieId,
    'System',
    'info',
    `Job queued in background (mode=${mode}${demoMode ? ', DEMO_MODE' : ''}). Safe to close or refresh browser.`
  );
  void drainQueue();
}

export function cancelDubbingJob(movieId: string): MovieProject | undefined {
  cancelledMovies.add(movieId);

  const qIdx = activeQueue.findIndex((j) => j.movieId === movieId);
  if (qIdx >= 0) {
    activeQueue.splice(qIdx, 1);
  }

  const movie = getMovie(movieId);
  if (!movie) return undefined;

  if (!runningMovies.has(movieId)) {
    const chunkStates = [...movie.chunkStates];
    const segments = [...movie.segments];
    revertProcessingStatesToPending(chunkStates, segments);
    const ttsCounts = computeTtsChunkCounts(segments);

    const updated = updateMovie(movieId, {
      status: 'paused',
      pauseReason: 'user_paused',
      pausedAt: new Date().toISOString(),
      chunkStates,
      segments,
      ...ttsCounts,
      error: 'Processing paused by user. All completed chunks are saved — click "Resume Processing" anytime to continue.',
      etaSeconds: null,
    });
    appendMovieLog(
      movieId,
      'System',
      'warn',
      'Processing paused while queued. Completed chunks preserved.'
    );
    return updated;
  }

  appendMovieLog(
    movieId,
    'System',
    'warn',
    'Pause requested; stopping after current API request while preserving all completed chunks.'
  );
  return getMovie(movieId);
}

export function resumePendingJobsOnStartup(): void {
  const interrupted = listRecoverableMovies();
  for (const movie of interrupted) {
    appendMovieLog(
      movie.id,
      'System',
      'warn',
      'Server restarted while job was active; resuming persisted dubbing job from last saved chunk.'
    );
    enqueueDubbingJob(
      movie.id,
      movie.status === 'scanning' ? 'scan' : 'resume_chunks',
      movie.demoMode
    );
  }
}

async function drainQueue(): Promise<void> {
  if (isDraining) return;
  isDraining = true;
  try {
    while (activeQueue.length > 0) {
      const next = activeQueue.shift()!;
      if (runningMovies.has(next.movieId)) continue;
      if (isJobCancelled(next.movieId)) {
        cancelledMovies.delete(next.movieId);
        continue;
      }
      runningMovies.add(next.movieId);
      try {
        await executeDubbingJob(next.movieId, next.mode, next.demoMode);
      } catch (err) {
        const latest = getMovie(next.movieId);
        const chunkStates = latest ? [...latest.chunkStates] : [];
        const segments = latest ? [...latest.segments] : [];

        if (err instanceof QuotaExhaustedError) {
          revertProcessingStatesToPending(chunkStates, segments);
          const ttsCounts = computeTtsChunkCounts(segments);
          const doneAsr = chunkStates.filter((c) => c.status === 'completed').length;
          const totalAsr = chunkStates.length;

          const pauseMsg =
            `Paused automatically: Gemini API daily quota reached (${err.model}). ` +
            `${doneAsr}/${totalAsr} speech chunks and ${ttsCounts.completedTtsChunks}/${ttsCounts.totalTtsChunks} Urdu audio chunks are safely saved. ` +
            `Click "Resume Processing" after quota resets (typically the next day) without re-uploading. ` +
            `Completion timing depends on Google's active Free Tier quotas, which may change.`;

          updateMovie(next.movieId, {
            status: 'paused',
            pauseReason: 'quota_exhausted',
            pausedAt: new Date().toISOString(),
            quotaResetAt: err.resetAtIso,
            etaSeconds: null,
            chunkStates,
            segments,
            completedChunks: doneAsr,
            failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
            ...ttsCounts,
            error: pauseMsg,
          });
          appendMovieLog(next.movieId, 'System', 'warn', pauseMsg);
        } else if (err instanceof JobCancelledError) {
          revertProcessingStatesToPending(chunkStates, segments);
          const ttsCounts = computeTtsChunkCounts(segments);
          const msg =
            'Processing paused by user. Completed chunks are saved — click "Resume Processing" to continue from the last incomplete chunk.';

          updateMovie(next.movieId, {
            status: 'paused',
            pauseReason: 'user_paused',
            pausedAt: new Date().toISOString(),
            etaSeconds: null,
            chunkStates,
            segments,
            completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
            failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
            ...ttsCounts,
            error: msg,
          });
          appendMovieLog(next.movieId, 'System', 'warn', msg);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          updateMovie(next.movieId, {
            status: 'failed',
            etaSeconds: null,
            error: msg,
          });
          appendMovieLog(next.movieId, 'System', 'error', `Job failed: ${msg}`);
        }
      } finally {
        runningMovies.delete(next.movieId);
        cancelledMovies.delete(next.movieId);
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

  if (isJobCancelled(movieId)) {
    throw new JobCancelledError();
  }

  if (!movie.rightsConfirmed) {
    throw new Error('Copyright permission confirmation is required before processing.');
  }

  if (!demoMode && !hasGeminiKey()) {
    throw new ProviderNotConfiguredError(
      'GEMINI_API_KEY is missing on the server. Configure GEMINI_API_KEY in Settings > Secrets, or explicitly start in clearly labeled Demo Mode.'
    );
  }

  const effectiveTargetMode: 'scan' | 'full' =
    mode === 'scan'
      ? 'scan'
      : mode === 'full'
        ? 'full'
        : movie.targetMode ?? 'full';

  const movieWorkDir = path.join(WORK_DIR, movieId);
  const chunksDir = path.join(movieWorkDir, 'chunks');
  const ttsDir = path.join(movieWorkDir, 'tts');
  fs.mkdirSync(movieWorkDir, { recursive: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(ttsDir, { recursive: true });

  const startedAt = movie.processingStartedAt ?? new Date().toISOString();
  const previousStatus = movie.status;

  updateMovie(movieId, {
    status: effectiveTargetMode === 'scan' ? 'scanning' : 'processing',
    targetMode: effectiveTargetMode,
    processingStartedAt: startedAt,
    pauseReason: undefined,
    pausedAt: undefined,
    quotaResetAt: undefined,
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

  if (isJobCancelled(movieId)) {
    throw new JobCancelledError();
  }

  // Stage 2: Extracting audio (reuse existing full_stereo.wav on resume!)
  setStage(movieId, 1, 8, null);
  const fullStereoWav = path.join(movieWorkDir, 'full_stereo.wav');
  const hasExistingWav =
    fs.existsSync(fullStereoWav) && fs.statSync(fullStereoWav).size > 4096;
  const hasCompletedScan =
    mode === 'full' &&
    previousStatus === 'ready_for_dubbing' &&
    movie.chunkStates.length > 0 &&
    movie.chunkStates.every((c) => c.status === 'completed');
  const preserveCompletedChunks =
    mode === 'resume_chunks' ||
    hasCompletedScan ||
    (previousStatus === 'paused' && movie.chunkStates.length > 0);

  if (preserveCompletedChunks && hasExistingWav) {
    appendMovieLog(
      movieId,
      'Extracting audio',
      'info',
      'Reusing previously extracted 48kHz stereo audio track from disk.'
    );
  } else {
    appendMovieLog(
      movieId,
      'Extracting audio',
      'info',
      'Extracting 48kHz stereo audio track via FFmpeg.'
    );
    await extractFullStereoAudio(movie.sourceVideoPath, fullStereoWav);
  }

  if (isJobCancelled(movieId)) {
    throw new JobCancelledError();
  }

  // Stage 3: Detecting Turkish speech & preparing overlapping chunks
  setStage(movieId, 2, 14, null);

  let chunks: ExtractedChunk[] = [];
  let chunkStates: ChunkState[] = [];

  const canPreserveSchedule = preserveCompletedChunks && movie.chunkStates.length > 0;

  if (canPreserveSchedule) {
    // Preserve exact existing chunk boundaries and completed statuses!
    chunkStates = movie.chunkStates.map((prev) => ({
      ...prev,
      status: prev.status === 'completed' ? 'completed' : 'pending',
      error: prev.status === 'completed' ? undefined : prev.error,
    }));

    for (const st of chunkStates) {
      const outMp3 = path.join(chunksDir, `chunk_${String(st.index).padStart(4, '0')}.mp3`);
      if (st.status !== 'completed') {
        const existsValid = fs.existsSync(outMp3) && fs.statSync(outMp3).size > 512;
        if (!existsValid) {
          await extractSingleChunkAudio(fullStereoWav, st.startSec, st.endSec, outMp3);
        }
      }
      chunks.push({
        index: st.index,
        startSec: st.startSec,
        endSec: st.endSec,
        audioPath: outMp3,
      });
    }

    const completedCount = chunkStates.filter((c) => c.status === 'completed').length;
    appendMovieLog(
      movieId,
      'Detecting Turkish speech',
      'info',
      `Resuming persisted schedule: ${completedCount}/${chunkStates.length} speech chunk(s) already completed and preserved.`
    );
  } else {
    chunks = await splitAudioIntoChunks(
      fullStereoWav,
      chunksDir,
      probe.durationSeconds,
      CHUNK_DURATION_SECONDS,
      CHUNK_OVERLAP_SECONDS,
      true
    );

    chunkStates = chunks.map((ch) => ({
      index: ch.index,
      startSec: ch.startSec,
      endSec: ch.endSec,
      status: 'pending',
      attempts: 0,
    }));

    appendMovieLog(
      movieId,
      'Detecting Turkish speech',
      'info',
      `Split ${probe.durationSeconds.toFixed(1)}s audio into ${chunks.length} overlapping segment(s) (${CHUNK_DURATION_SECONDS}s window, ${CHUNK_OVERLAP_SECONDS}s overlap).`
    );
  }

  updateMovie(movieId, {
    totalChunks: chunks.length,
    completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
    failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
    chunkStates,
  });

  // Clearly labeled Demo Mode pipeline
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
      seg.ttsStatus = 'completed';
    }

    setStage(movieId, 7, 72, 3);
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
      ...computeTtsChunkCounts(demoSegs),
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
  if (preserveCompletedChunks) {
    for (const seg of movie.segments) {
      const arr = existingSegmentsByChunk.get(seg.chunkIndex) ?? [];
      arr.push({ ...seg });
      existingSegmentsByChunk.set(seg.chunkIndex, arr);
    }
  }

  const allSegments: DialogueSegment[] = [];
  const chunkDurationsMs: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (isJobCancelled(movieId)) {
      throw new JobCancelledError();
    }

    const chunk = chunks[i];
    const state = chunkStates[i];

    // Preserve completed ASR/translation chunks even if a silent/music-only chunk had 0 dialogue segments
    if (preserveCompletedChunks && state.status === 'completed') {
      const preserved = existingSegmentsByChunk.get(i) ?? [];
      for (const seg of preserved) {
        const char = mergeSpeakerIntoRoster(movie, roster, seg);
        if (seg.voiceProfileId !== char.voiceProfileId) {
          seg.voiceProfileId = char.voiceProfileId;
          if (seg.ttsStatus === 'completed' && seg.ttsVoiceProfileId && seg.ttsVoiceProfileId !== char.voiceProfileId) {
            seg.ttsStatus = 'pending';
            seg.timedWavPath = undefined;
          }
        }
        allSegments.push(seg);
      }
      continue;
    }

    state.status = 'processing';
    state.error = undefined;
    updateMovie(movieId, { chunkStates: [...chunkStates] });

    const chunkStartMs = Date.now();
    let chunkSucceeded = false;
    let lastChunkErr = '';
    let isPermanentErr = false;

    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
      if (isJobCancelled(movieId)) {
        throw new JobCancelledError();
      }

      state.attempts = attempt;
      updateMovie(movieId, { chunkStates: [...chunkStates] });

      try {
        const completedCount = chunkStates.filter((c) => c.status === 'completed').length;
        const avgChunkMs =
          chunkDurationsMs.length > 0
            ? chunkDurationsMs.reduce((a, b) => a + b, 0) / chunkDurationsMs.length
            : null;
        const remainingChunks = chunks.length - completedCount;
        const etaSec =
          avgChunkMs !== null ? Math.round((avgChunkMs * remainingChunks) / 1000) + 12 : null;

        // Stage 4: Transcribing dialogue + Stage 5: Identifying speakers
        const basePct = 18 + (completedCount / Math.max(1, chunks.length)) * 36;
        setStage(movieId, 3, basePct, etaSec);

        const diarizedLines = await asrAdapter.transcribeAndDiarizeChunk({
          chunkAudioPath: chunk.audioPath,
          chunkIndex: i,
          chunkStartSec: chunk.startSec,
          chunkEndSec: chunk.endSec,
          knownCharacters: roster,
          shouldCancel: () => isJobCancelled(movieId),
          onLog: (level, msg) => appendMovieLog(movieId, 'Transcribing dialogue', level, msg),
        });

        setStage(movieId, 4, basePct + 10 / Math.max(1, chunks.length), etaSec);

        // Deduplicate lines captured inside overlap region from previous chunk
        const freshLines = deduplicateBoundaryLines(allSegments, diarizedLines);

        // Stage 6: Translating Turkish into Urdu
        setStage(movieId, 5, basePct + 18 / Math.max(1, chunks.length), etaSec);
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
                shouldCancel: () => isJobCancelled(movieId),
                onLog: (level, msg) => appendMovieLog(movieId, 'Translating Turkish into Urdu', level, msg),
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
            ttsStatus: 'pending',
            ttsAttempts: 0,
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
          `Speech chunk ${i + 1}/${chunks.length} completed (${freshLines.length} dialogue lines, ${(elapsed / 1000).toFixed(1)}s${attempt > 1 ? `, recovered on attempt ${attempt}` : ''}).`
        );
        break;
      } catch (err) {
        if (err instanceof QuotaExhaustedError || err instanceof JobCancelledError) {
          // Persist all earlier chunks and revert current chunk cleanly before propagating pause
          state.status = 'pending';
          updateMovie(movieId, {
            chunkStates: [...chunkStates],
            completedChunks: chunkStates.filter((c) => c.status === 'completed').length,
            failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
            characters: roster,
            segments: allSegments,
            ...computeTtsChunkCounts(allSegments),
          });
          throw err;
        }

        const classified = classifyGeminiError(err);
        lastChunkErr = classified.message;
        isPermanentErr = classified.category === 'permanent';
        appendMovieLog(
          movieId,
          'Transcribing dialogue',
          isPermanentErr ? 'error' : 'warn',
          `Chunk ${i + 1}/${chunks.length} attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} (${classified.category}) failed: ${lastChunkErr}`
        );

        if (isPermanentErr || attempt === MAX_CHUNK_ATTEMPTS) {
          break;
        }

        const backoffMs = Math.min(30_000, 2000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 500);
        await sleepWithCancel(backoffMs, () => isJobCancelled(movieId));
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
        ...computeTtsChunkCounts(allSegments),
      });
      throw new Error(
        isPermanentErr
          ? `Chunk ${i + 1} failed (permanent error): ${lastChunkErr}`
          : `Chunk ${i + 1} failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${lastChunkErr}`
      );
    }

    const doneNow = chunkStates.filter((c) => c.status === 'completed').length;
    const progressNow = 18 + (doneNow / Math.max(1, chunks.length)) * 36;
    updateMovie(movieId, {
      chunkStates: [...chunkStates],
      completedChunks: doneNow,
      failedChunks: chunkStates.filter((c) => c.status === 'failed').length,
      progressPercent: Math.round(progressNow),
      characters: roster,
      segments: allSegments,
      ...computeTtsChunkCounts(allSegments),
    });
  }

  allSegments.sort((a, b) => a.startSec - b.startSec);

  // If user requested speaker discovery scan only, stop cleanly so they can customize character voices
  if (effectiveTargetMode === 'scan') {
    updateMovie(movieId, {
      status: 'ready_for_dubbing',
      currentStage: 'Identifying speakers',
      stageIndex: 4,
      progressPercent: 50,
      etaSeconds: null,
      characters: roster,
      segments: allSegments,
      ...computeTtsChunkCounts(allSegments),
    });
    appendMovieLog(
      movieId,
      'Identifying speakers',
      'success',
      `Speaker scan complete: identified ${roster.length} character(s) across ${allSegments.length} dialogue lines. Ready for voice review.`
    );
    return;
  }

  // Re-apply latest user-edited character voice locks before generating Urdu TTS!
  const refreshedMovie = getMovie(movieId);
  const lockedRoster = refreshedMovie?.characters.length ? refreshedMovie.characters : roster;
  const lockedMap = new Map(lockedRoster.map((c) => [c.speakerLabel, c]));
  for (const seg of allSegments) {
    const locked = lockedMap.get(seg.speakerLabel);
    if (locked) {
      const voiceChanged =
        seg.ttsStatus === 'completed' &&
        seg.ttsVoiceProfileId &&
        seg.ttsVoiceProfileId !== locked.voiceProfileId;
      seg.voiceProfileId = locked.voiceProfileId;
      seg.gender = locked.gender;
      if (voiceChanged) {
        seg.ttsStatus = 'pending';
        seg.timedWavPath = undefined;
      }
    }
  }

  // Normalize initial TTS status from disk cache so previously synthesized chunks are never regenerated
  for (let idx = 0; idx < allSegments.length; idx++) {
    const seg = allSegments[idx];
    const voiceProfile =
      URDU_VOICE_PROFILES.find((v) => v.id === seg.voiceProfileId) ?? URDU_VOICE_PROFILES[0];
    const deterministicTimed = path.join(ttsDir, `timed_${seg.id}_${voiceProfile.id}.wav`);
    const legacyTimed = path.join(ttsDir, `timed_${idx}_${voiceProfile.id}.wav`);

    if (!fs.existsSync(deterministicTimed) && fs.existsSync(legacyTimed) && fs.statSync(legacyTimed).size > 1024) {
      fs.copyFileSync(legacyTimed, deterministicTimed);
    }

    if (fs.existsSync(deterministicTimed) && fs.statSync(deterministicTimed).size > 1024) {
      seg.ttsStatus = 'completed';
      seg.ttsVoiceProfileId = voiceProfile.id;
      seg.timedWavPath = deterministicTimed;
      seg.ttsError = undefined;
    } else if (seg.ttsStatus === 'completed' && !fs.existsSync(deterministicTimed)) {
      // Missing file on disk means we must synthesize it cleanly
      seg.ttsStatus = 'pending';
      seg.timedWavPath = undefined;
    } else if (!seg.ttsStatus) {
      seg.ttsStatus = 'pending';
    }
  }

  const initialTtsCounts = computeTtsChunkCounts(allSegments);
  updateMovie(movieId, {
    characters: lockedRoster,
    segments: allSegments,
    ...initialTtsCounts,
  });

  // Stage 7: Generating Urdu voices + Stage 8: Synchronizing dialogue
  setStage(
    movieId,
    6,
    55 + (initialTtsCounts.completedTtsChunks / Math.max(1, allSegments.length)) * 35,
    null
  );
  appendMovieLog(
    movieId,
    'Generating Urdu voices',
    'info',
    `Urdu TTS queue: ${initialTtsCounts.completedTtsChunks}/${initialTtsCounts.totalTtsChunks} audio chunk(s) already completed; ${initialTtsCounts.remainingTtsChunks} pending.`
  );

  for (let idx = 0; idx < allSegments.length; idx++) {
    if (isJobCancelled(movieId)) {
      throw new JobCancelledError();
    }

    const seg = allSegments[idx];
    const voiceProfile =
      URDU_VOICE_PROFILES.find((v) => v.id === seg.voiceProfileId) ?? URDU_VOICE_PROFILES[0];

    const rawWav = path.join(ttsDir, `raw_${seg.id}_${voiceProfile.id}.wav`);
    const timedWav = path.join(ttsDir, `timed_${seg.id}_${voiceProfile.id}.wav`);

    // Skip already completed Urdu audio chunks without regenerating
    if (
      seg.ttsStatus === 'completed' &&
      seg.ttsVoiceProfileId === voiceProfile.id &&
      fs.existsSync(timedWav) &&
      fs.statSync(timedWav).size > 1024
    ) {
      seg.timedWavPath = timedWav;
      continue;
    }

    seg.ttsStatus = 'processing';
    seg.ttsAttempts = (seg.ttsAttempts ?? 0) + 1;
    seg.ttsError = undefined;
    updateMovie(movieId, {
      segments: allSegments,
      ...computeTtsChunkCounts(allSegments),
    });

    try {
      await ttsAdapter.synthesizeLine({
        urduText: seg.urduText,
        emotion: seg.emotion,
        voiceProfile,
        outWavPath: rawWav,
        shouldCancel: () => isJobCancelled(movieId),
        onLog: (level, msg) => appendMovieLog(movieId, 'Generating Urdu voices', level, msg),
      });

      const countsAfterSynth = computeTtsChunkCounts(allSegments);
      setStage(
        movieId,
        7,
        55 + ((countsAfterSynth.completedTtsChunks + 0.5) / Math.max(1, allSegments.length)) * 35
      );

      await fitSegmentTiming(
        rawWav,
        timedWav,
        Math.max(0.6, seg.endSec - seg.startSec),
        voiceProfile.pitchSemitones
      );

      seg.ttsStatus = 'completed';
      seg.ttsVoiceProfileId = voiceProfile.id;
      seg.timedWavPath = timedWav;
      seg.ttsError = undefined;
      seg.ttsCompletedAt = new Date().toISOString();

      const updatedCounts = computeTtsChunkCounts(allSegments);
      updateMovie(movieId, {
        progressPercent: Math.round(
          55 + (updatedCounts.completedTtsChunks / Math.max(1, allSegments.length)) * 35
        ),
        segments: allSegments,
        ...updatedCounts,
      });
    } catch (err) {
      if (err instanceof QuotaExhaustedError || err instanceof JobCancelledError) {
        seg.ttsStatus = 'pending';
        updateMovie(movieId, {
          segments: allSegments,
          ...computeTtsChunkCounts(allSegments),
        });
        throw err;
      }

      const msg = err instanceof Error ? err.message : String(err);
      seg.ttsStatus = 'failed';
      seg.ttsError = msg.slice(0, 300);
      updateMovie(movieId, {
        segments: allSegments,
        ...computeTtsChunkCounts(allSegments),
      });
      throw new Error(`Urdu audio chunk ${idx + 1}/${allSegments.length} failed: ${msg}`);
    }
  }

  if (isJobCancelled(movieId)) {
    throw new JobCancelledError();
  }

  // Stage 9: Mixing audio (source separation / SFX preservation + sidechain ducking)
  setStage(movieId, 8, 92, 6);
  const sepUrl = process.env.SOURCE_SEPARATION_URL?.trim();
  const sepMethod = sepUrl
    ? `External Stem Separator (${sepUrl})`
    : 'FFmpeg Mid-Side Dialogue Suppression + Sidechain Ducking';

  appendMovieLog(
    movieId,
    'Mixing audio',
    'info',
    `Isolating background music/SFX (${sepMethod}) and mixing all ${allSegments.length} synchronized Urdu voice chunks.`
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
  const finalTtsCounts = computeTtsChunkCounts(allSegments);
  updateMovie(movieId, {
    status: 'completed',
    currentStage: 'Rendering final MP4',
    stageIndex: 9,
    progressPercent: 100,
    etaSeconds: 0,
    pauseReason: undefined,
    pausedAt: undefined,
    quotaResetAt: undefined,
    characters: lockedRoster,
    ...finalTtsCounts,
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
