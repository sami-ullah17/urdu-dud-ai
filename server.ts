import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  type AuthenticatedRequest,
  issueStudioToken,
  requireAuth,
  resolveAuthFromRequest,
  signDownloadUrlToken,
  verifyDownloadUrlToken,
} from './server/auth.ts';
import {
  UPLOADS_DIR,
  createMovie,
  createUploadSession,
  deleteMovieRecord,
  deleteUploadSession,
  getMovie,
  getUploadSession,
  getUser,
  listMoviesByOwner,
  updateMovieCharacters,
  updateUploadSession,
  upsertUser,
} from './server/store.ts';
import {
  URDU_VOICE_PROFILES,
  type CharacterProfile,
  type MovieFormat,
  type MovieProject,
} from './server/types.ts';
import {
  GeminiUrduTtsAdapter,
  generateTurkishDualSpeakerSampleWav,
  getProviderDiagnostics,
} from './server/providers/dubbingAdapters.ts';
import {
  checkFfmpegAvailable,
  probeVideo,
  renderSyntheticVideoFromWav,
} from './server/providers/ffmpegPipeline.ts';
import { hasGeminiKey, ProviderNotConfiguredError } from './server/providers/geminiClient.ts';
import { enqueueDubbingJob, resumePendingJobsOnStartup, type JobMode } from './server/queue.ts';

const PORT = Number(process.env.PORT ?? 3000) || 3000;
const MAX_UPLOAD_GB = Math.max(1, Number(process.env.MAX_UPLOAD_GB ?? 10) || 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_GB * 1024 * 1024 * 1024;
const MAX_DURATION_MINUTES = Math.min(
  180,
  Math.max(1, Number(process.env.MAX_DURATION_MINUTES ?? 180) || 180)
);
const MAX_DURATION_SECONDS = MAX_DURATION_MINUTES * 60;
const SHORT_CLIP_TEST_MINUTES = Math.max(
  1,
  Number(process.env.SHORT_CLIP_TEST_MINUTES ?? 10) || 10
);

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);

function parseFormat(filename: string): MovieFormat | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp4') return 'mp4';
  if (ext === '.mov') return 'mov';
  if (ext === '.mkv') return 'mkv';
  return null;
}

function sanitizeMovieForClient(movie: MovieProject, includeSegments = false) {
  const sourceSig = signDownloadUrlToken(movie.id, movie.ownerId, 'source');
  const mp4Sig = movie.outputMp4Path
    ? signDownloadUrlToken(movie.id, movie.ownerId, 'mp4')
    : null;
  const srtSig = movie.outputSrtPath
    ? signDownloadUrlToken(movie.id, movie.ownerId, 'srt')
    : null;

  return {
    id: movie.id,
    ownerId: movie.ownerId,
    title: movie.title,
    originalFilename: movie.originalFilename,
    format: movie.format,
    fileSizeBytes: movie.fileSizeBytes,
    durationSeconds: movie.durationSeconds,
    width: movie.width,
    height: movie.height,
    sourceLang: movie.sourceLang,
    targetLang: movie.targetLang,
    rightsConfirmed: movie.rightsConfirmed,
    status: movie.status,
    currentStage: movie.currentStage,
    stageIndex: movie.stageIndex,
    progressPercent: movie.progressPercent,
    etaSeconds: movie.etaSeconds,
    totalChunks: movie.totalChunks,
    completedChunks: movie.completedChunks,
    failedChunks: movie.failedChunks,
    chunkStates: movie.chunkStates,
    characters: movie.characters,
    segmentsCount: movie.segments.length,
    segments: includeSegments ? movie.segments.slice(0, 200) : undefined,
    logs: movie.logs.slice(-80),
    outputMp4SizeBytes: movie.outputMp4SizeBytes,
    sourceSeparationMethod: movie.sourceSeparationMethod,
    demoMode: movie.demoMode,
    error: movie.error,
    createdAt: movie.createdAt,
    updatedAt: movie.updatedAt,
    processingStartedAt: movie.processingStartedAt,
    processingCompletedAt: movie.processingCompletedAt,
    sourcePreviewUrl: `/api/dubbing/${movie.id}/download?type=source&sig=${encodeURIComponent(sourceSig)}`,
    downloadMp4Url: mp4Sig
      ? `/api/dubbing/${movie.id}/download?type=mp4&sig=${encodeURIComponent(mp4Sig)}`
      : null,
    downloadSrtUrl: srtSig
      ? `/api/dubbing/${movie.id}/download?type=srt&sig=${encodeURIComponent(srtSig)}`
      : null,
  };
}

function isFirebaseConfigPresent(): boolean {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (cfg.projectId && cfg.projectId !== 'remixed-project-id') return true;
    } catch {
      // ignore
    }
  }
  return Boolean(process.env.VITE_FIREBASE_API_KEY && process.env.VITE_FIREBASE_PROJECT_ID);
}

const tmpUploadDir = path.join(UPLOADS_DIR, 'tmp');
fs.mkdirSync(tmpUploadDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported video format. Allowed formats: MP4, MOV, MKV.'));
      return;
    }
    cb(null, true);
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Auth: Local Studio Session (used when Firebase is not yet provisioned or for direct studio sign-in)
  app.post('/api/auth/studio-session', (req: Request, res: Response) => {
    const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const displayNameRaw =
      typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';

    if (!emailRaw || !emailRaw.includes('@')) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    const uid = `studio_${crypto.createHash('sha256').update(emailRaw).digest('hex').slice(0, 16)}`;
    const user = upsertUser({
      uid,
      email: emailRaw.slice(0, 254),
      displayName: (displayNameRaw || emailRaw.split('@')[0]).slice(0, 100),
      shortClipVerified: getUser(uid)?.shortClipVerified ?? false,
      createdAt: getUser(uid)?.createdAt ?? new Date().toISOString(),
    });

    const token = issueStudioToken(user);
    res.json({ token, user });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const stored = getUser(req.user!.uid);
    res.json({
      user: {
        uid: req.user!.uid,
        email: req.user!.email,
        displayName: stored?.displayName ?? req.user!.displayName,
        shortClipVerified: stored?.shortClipVerified ?? false,
        authMode: req.user!.authMode,
      },
    });
  });

  // Public system diagnostics & limits
  app.get('/api/health/providers', async (_req: Request, res: Response) => {
    const mediaTools = await checkFfmpegAvailable();
    const providers = getProviderDiagnostics();
    res.json({
      ...providers,
      ffmpegAvailable: mediaTools.ffmpeg,
      ffprobeAvailable: mediaTools.ffprobe,
      firebaseConfigured: isFirebaseConfigPresent(),
      limits: {
        maxUploadGb: MAX_UPLOAD_GB,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxDurationMinutes: MAX_DURATION_MINUTES,
        shortClipTestMinutes: SHORT_CLIP_TEST_MINUTES,
        supportedFormats: ['MP4', 'MOV', 'MKV'],
      },
    });
  });

  app.get('/api/voices', (_req: Request, res: Response) => {
    res.json({ voices: URDU_VOICE_PROFILES });
  });

  // Voice preview synthesis via Gemini TTS
  app.post('/api/voices/preview', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const voiceProfileId = String(req.body?.voiceProfileId ?? '');
    const customText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const profile = URDU_VOICE_PROFILES.find((v) => v.id === voiceProfileId);
    if (!profile) {
      res.status(400).json({ error: 'Invalid Pakistani Urdu voice profile ID.' });
      return;
    }

    if (!hasGeminiKey()) {
      res.status(503).json({
        code: 'PROVIDER_NOT_CONFIGURED',
        error:
          'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets to generate live Pakistani Urdu voice previews.',
      });
      return;
    }

    const sampleLine =
      customText ||
      (profile.gender === 'male'
        ? 'السلام علیکم، میں اس فلم میں اپنی اردو آواز کے ساتھ کردار ادا کر رہا ہوں۔'
        : 'السلام علیکم، اس منظر میں میری اردو آواز کردار کے جذبات کی عکاسی کرے گی۔');

    const tmpPreview = path.join(
      tmpUploadDir,
      `preview_${crypto.randomUUID()}.wav`
    );

    try {
      const tts = new GeminiUrduTtsAdapter();
      await tts.synthesizeLine({
        urduText: sampleLine,
        emotion: 'warm cinematic delivery',
        voiceProfile: profile,
        outWavPath: tmpPreview,
      });
      const wavBase64 = fs.readFileSync(tmpPreview).toString('base64');
      res.json({
        voiceProfileId: profile.id,
        mimeType: 'audio/wav',
        audioBase64: wavBase64,
        sampleText: sampleLine,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(err instanceof ProviderNotConfiguredError ? 503 : 500).json({
        error: msg,
      });
    } finally {
      if (fs.existsSync(tmpPreview)) {
        fs.unlinkSync(tmpPreview);
      }
    }
  });

  // Resumable Chunked Upload Endpoints (supports 3-hour / multi-GB files without memory spikes)
  app.post('/api/movies/upload/init', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const originalFilename = String(req.body?.filename ?? '').trim();
    const title = String(req.body?.title ?? '').trim() || originalFilename;
    const expectedSizeBytes = Number(req.body?.fileSizeBytes ?? 0);
    const rightsConfirmed = req.body?.rightsConfirmed === true;

    if (!rightsConfirmed) {
      res.status(400).json({
        error: 'You must confirm ownership or legal dubbing permission before uploading.',
      });
      return;
    }

    const format = parseFormat(originalFilename);
    if (!format) {
      res.status(400).json({ error: 'Unsupported format. Please upload MP4, MOV, or MKV.' });
      return;
    }

    if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) {
      res.status(400).json({ error: 'Invalid file size.' });
      return;
    }

    if (expectedSizeBytes > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `File exceeds configured storage limit of ${MAX_UPLOAD_GB} GB.`,
      });
      return;
    }

    const uploadId = `upl_${crypto.randomUUID().replace(/-/g, '')}`;
    const tempFilePath = path.join(tmpUploadDir, `${uploadId}.part`);
    fs.writeFileSync(tempFilePath, Buffer.alloc(0));

    createUploadSession({
      uploadId,
      ownerId: req.user!.uid,
      title: title.slice(0, 180),
      originalFilename: originalFilename.slice(0, 255),
      format,
      expectedSizeBytes,
      receivedBytes: 0,
      rightsConfirmed: true,
      tempFilePath,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ uploadId, maxChunkSizeBytes: 8 * 1024 * 1024 });
  });

  app.put(
    '/api/movies/upload/chunk/:uploadId',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: '32mb' }),
    (req: AuthenticatedRequest, res: Response) => {
      const session = getUploadSession(req.params.uploadId);
      if (!session || session.ownerId !== req.user!.uid) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }

      const chunkBuf = req.body as Buffer;
      if (!Buffer.isBuffer(chunkBuf) || chunkBuf.length === 0) {
        res.status(400).json({ error: 'Empty chunk payload.' });
        return;
      }

      const nextSize = session.receivedBytes + chunkBuf.length;
      if (nextSize > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_GB} GB storage limit.` });
        return;
      }

      fs.appendFileSync(session.tempFilePath, chunkBuf);
      updateUploadSession(session.uploadId, { receivedBytes: nextSize });
      res.json({ uploadId: session.uploadId, receivedBytes: nextSize });
    }
  );

  app.post(
    '/api/movies/upload/complete/:uploadId',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const session = getUploadSession(req.params.uploadId);
      if (!session || session.ownerId !== req.user!.uid) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }

      const finalId = `mov_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const finalVideoPath = path.join(UPLOADS_DIR, `${finalId}.${session.format}`);

      try {
        fs.renameSync(session.tempFilePath, finalVideoPath);
        const probe = await probeVideo(finalVideoPath);
        if (!probe.hasVideo || !probe.hasAudio) {
          fs.unlinkSync(finalVideoPath);
          deleteUploadSession(session.uploadId);
          res.status(400).json({
            error: 'Invalid media file: both a video track and an audio track are required.',
          });
          return;
        }
        if (probe.durationSeconds > MAX_DURATION_SECONDS) {
          fs.unlinkSync(finalVideoPath);
          deleteUploadSession(session.uploadId);
          res.status(400).json({
            error: `Video duration (${(probe.durationSeconds / 60).toFixed(1)} min) exceeds maximum limit of ${MAX_DURATION_MINUTES} minutes.`,
          });
          return;
        }

        const stats = fs.statSync(finalVideoPath);
        const now = new Date().toISOString();
        const movie = createMovie({
          id: finalId,
          ownerId: req.user!.uid,
          title: session.title,
          originalFilename: session.originalFilename,
          format: session.format,
          fileSizeBytes: stats.size,
          durationSeconds: probe.durationSeconds,
          width: probe.width,
          height: probe.height,
          sourceLang: 'tr',
          targetLang: 'ur-PK',
          rightsConfirmed: true,
          status: 'uploaded',
          currentStage: 'Uploading movie',
          stageIndex: 0,
          progressPercent: 100,
          etaSeconds: null,
          totalChunks: 0,
          completedChunks: 0,
          failedChunks: 0,
          chunkStates: [],
          characters: [],
          segments: [],
          logs: [
            {
              id: crypto.randomUUID(),
              stage: 'Uploading movie',
              level: 'success',
              message: `Uploaded ${session.originalFilename} (${(stats.size / (1024 * 1024)).toFixed(2)} MB, ${(probe.durationSeconds / 60).toFixed(2)} min).`,
              createdAt: now,
            },
          ],
          sourceVideoPath: finalVideoPath,
          demoMode: false,
          createdAt: now,
          updatedAt: now,
        });

        deleteUploadSession(session.uploadId);
        res.status(201).json({ movie: sanitizeMovieForClient(movie) });
      } catch (err) {
        if (fs.existsSync(finalVideoPath)) fs.unlinkSync(finalVideoPath);
        if (fs.existsSync(session.tempFilePath)) fs.unlinkSync(session.tempFilePath);
        deleteUploadSession(session.uploadId);
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to finalize uploaded video.',
        });
      }
    }
  );

  // Standard Multipart Upload Endpoint (Section 8: POST /api/movies/upload)
  app.post(
    '/api/movies/upload',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      uploadMiddleware.single('video')(req, res, async (uploadErr) => {
        if (uploadErr) {
          res.status(400).json({
            error: uploadErr instanceof Error ? uploadErr.message : 'Upload failed.',
          });
          return;
        }
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: 'No video file attached under field "video".' });
          return;
        }
        const rightsConfirmed =
          req.body?.rightsConfirmed === 'true' || req.body?.rightsConfirmed === true;
        if (!rightsConfirmed) {
          fs.unlinkSync(file.path);
          res.status(400).json({
            error: 'You must confirm ownership or dubbing rights before uploading.',
          });
          return;
        }

        const format = parseFormat(file.originalname);
        if (!format) {
          fs.unlinkSync(file.path);
          res.status(400).json({ error: 'Unsupported format. Allowed: MP4, MOV, MKV.' });
          return;
        }

        try {
          const probe = await probeVideo(file.path);
          if (!probe.hasVideo || !probe.hasAudio) {
            fs.unlinkSync(file.path);
            res.status(400).json({
              error: 'Video file must contain both a valid video stream and an audio stream.',
            });
            return;
          }
          if (probe.durationSeconds > MAX_DURATION_SECONDS) {
            fs.unlinkSync(file.path);
            res.status(400).json({
              error: `Video duration (${(probe.durationSeconds / 60).toFixed(1)} min) exceeds ${MAX_DURATION_MINUTES} minutes.`,
            });
            return;
          }

          const id = `mov_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const now = new Date().toISOString();
          const title =
            (typeof req.body?.title === 'string' && req.body.title.trim()) ||
            file.originalname.replace(/\.[^.]+$/, '');

          const movie = createMovie({
            id,
            ownerId: req.user!.uid,
            title: title.slice(0, 180),
            originalFilename: file.originalname.slice(0, 255),
            format,
            fileSizeBytes: file.size,
            durationSeconds: probe.durationSeconds,
            width: probe.width,
            height: probe.height,
            sourceLang: 'tr',
            targetLang: 'ur-PK',
            rightsConfirmed: true,
            status: 'uploaded',
            currentStage: 'Uploading movie',
            stageIndex: 0,
            progressPercent: 100,
            etaSeconds: null,
            totalChunks: 0,
            completedChunks: 0,
            failedChunks: 0,
            chunkStates: [],
            characters: [],
            segments: [],
            logs: [
              {
                id: crypto.randomUUID(),
                stage: 'Uploading movie',
                level: 'success',
                message: `Uploaded ${file.originalname} (${(file.size / (1024 * 1024)).toFixed(2)} MB, ${(probe.durationSeconds / 60).toFixed(2)} min).`,
                createdAt: now,
              },
            ],
            sourceVideoPath: file.path,
            demoMode: false,
            createdAt: now,
            updatedAt: now,
          });

          res.status(201).json({ movie: sanitizeMovieForClient(movie) });
        } catch (err) {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
          res.status(500).json({
            error: err instanceof Error ? err.message : 'Failed to inspect uploaded video.',
          });
        }
      });
    }
  );

  // Create a real short Turkish two-speaker test clip for short-video pipeline verification
  app.post(
    '/api/movies/sample-turkish',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      if (!hasGeminiKey()) {
        res.status(503).json({
          code: 'PROVIDER_NOT_CONFIGURED',
          error:
            'GEMINI_API_KEY is required to synthesize a live Turkish two-speaker test clip. Configure GEMINI_API_KEY in Settings > Secrets or upload your own MP4/MOV/MKV file.',
        });
        return;
      }

      const id = `mov_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const tmpWav = path.join(tmpUploadDir, `${id}_tr_sample.wav`);
      const outMp4 = path.join(UPLOADS_DIR, `${id}.mp4`);

      try {
        await generateTurkishDualSpeakerSampleWav(tmpWav);
        await renderSyntheticVideoFromWav(tmpWav, outMp4, 'Istanbul Train Station (Test Clip)');
        const probe = await probeVideo(outMp4);
        const stats = fs.statSync(outMp4);
        const now = new Date().toISOString();

        const movie = createMovie({
          id,
          ownerId: req.user!.uid,
          title: 'Istanbul Train Station — Turkish Test Clip',
          originalFilename: 'turkish_dialogue_test_clip.mp4',
          format: 'mp4',
          fileSizeBytes: stats.size,
          durationSeconds: probe.durationSeconds,
          width: probe.width,
          height: probe.height,
          sourceLang: 'tr',
          targetLang: 'ur-PK',
          rightsConfirmed: true,
          status: 'uploaded',
          currentStage: 'Uploading movie',
          stageIndex: 0,
          progressPercent: 100,
          etaSeconds: null,
          totalChunks: 0,
          completedChunks: 0,
          failedChunks: 0,
          chunkStates: [],
          characters: [],
          segments: [],
          logs: [
            {
              id: crypto.randomUUID(),
              stage: 'Uploading movie',
              level: 'success',
              message: `Created short Turkish two-speaker test clip (${probe.durationSeconds.toFixed(1)}s) for pipeline verification.`,
              createdAt: now,
            },
          ],
          sourceVideoPath: outMp4,
          demoMode: false,
          createdAt: now,
          updatedAt: now,
        });

        res.status(201).json({ movie: sanitizeMovieForClient(movie) });
      } catch (err) {
        if (fs.existsSync(outMp4)) fs.unlinkSync(outMp4);
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to create Turkish test clip.',
        });
      } finally {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      }
    }
  );

  // List movies for authenticated user
  app.get('/api/movies', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movies = listMoviesByOwner(req.user!.uid);
    const stats = {
      total: movies.length,
      processing: movies.filter(
        (m) => m.status === 'processing' || m.status === 'queued' || m.status === 'scanning'
      ).length,
      completed: movies.filter((m) => m.status === 'completed').length,
      failed: movies.filter((m) => m.status === 'failed').length,
    };
    res.json({
      stats,
      movies: movies.map((m) => sanitizeMovieForClient(m, false)),
    });
  });

  // Get single movie detail
  app.get('/api/movies/:id', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Movie project not found.' });
      return;
    }
    res.json({ movie: sanitizeMovieForClient(movie, true) });
  });

  // Start or resume dubbing pipeline
  app.post('/api/dubbing/:id/start', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Movie project not found.' });
      return;
    }

    const modeRaw = req.body?.mode;
    const mode: JobMode =
      modeRaw === 'scan' || modeRaw === 'resume_chunks' ? modeRaw : 'full';
    const demoMode = req.body?.demoMode === true;

    if (!demoMode && !hasGeminiKey()) {
      res.status(503).json({
        code: 'PROVIDER_NOT_CONFIGURED',
        error:
          'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets, or explicitly choose Demo Mode to preview the workflow.',
      });
      return;
    }

    // Encourage short-clip workflow verification before running 3-hour films (configurable override supported)
    const user = getUser(req.user!.uid);
    const isLongMovie = movie.durationSeconds > SHORT_CLIP_TEST_MINUTES * 60;
    const bypassShortClipGate = req.body?.confirmLongMovie === true;
    if (isLongMovie && !user?.shortClipVerified && !bypassShortClipGate && !demoMode) {
      res.status(409).json({
        code: 'SHORT_CLIP_TEST_RECOMMENDED',
        error: `This video is ${(movie.durationSeconds / 60).toFixed(1)} minutes long. We recommend verifying a short clip (<= ${SHORT_CLIP_TEST_MINUTES} min) first, or pass confirmLongMovie=true to proceed directly.`,
      });
      return;
    }

    enqueueDubbingJob(movie.id, mode, demoMode);
    const updated = getMovie(movie.id)!;
    res.json({ movie: sanitizeMovieForClient(updated, true) });
  });

  // Get real dubbing job status & stage progress
  app.get('/api/dubbing/:id/status', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Dubbing job not found.' });
      return;
    }
    res.json({
      id: movie.id,
      status: movie.status,
      currentStage: movie.currentStage,
      stageIndex: movie.stageIndex,
      progressPercent: movie.progressPercent,
      etaSeconds: movie.etaSeconds,
      totalChunks: movie.totalChunks,
      completedChunks: movie.completedChunks,
      failedChunks: movie.failedChunks,
      chunkStates: movie.chunkStates,
      logs: movie.logs.slice(-120),
      demoMode: movie.demoMode,
      error: movie.error,
      sourceSeparationMethod: movie.sourceSeparationMethod,
      processingStartedAt: movie.processingStartedAt,
      processingCompletedAt: movie.processingCompletedAt,
    });
  });

  // Get identified characters
  app.get('/api/dubbing/:id/characters', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Movie project not found.' });
      return;
    }
    res.json({
      movieId: movie.id,
      characters: movie.characters,
      voices: URDU_VOICE_PROFILES,
    });
  });

  // Update character gender, display name, and locked Pakistani Urdu voice profile
  app.put('/api/dubbing/:id/characters', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Movie project not found.' });
      return;
    }

    const incoming = req.body?.characters;
    if (!Array.isArray(incoming)) {
      res.status(400).json({ error: 'Body must include a "characters" array.' });
      return;
    }

    const validVoiceIds = new Set(URDU_VOICE_PROFILES.map((v) => v.id));
    const existingById = new Map(movie.characters.map((c) => [c.id, c]));

    const updatedChars: CharacterProfile[] = incoming.map((item: Partial<CharacterProfile>) => {
      const existing = item.id ? existingById.get(item.id) : undefined;
      const gender =
        item.gender === 'male' || item.gender === 'female' || item.gender === 'unknown'
          ? item.gender
          : existing?.gender ?? 'unknown';
      const voiceProfileId =
        item.voiceProfileId && validVoiceIds.has(item.voiceProfileId)
          ? item.voiceProfileId
          : existing?.voiceProfileId ?? URDU_VOICE_PROFILES[0].id;

      return {
        id: existing?.id ?? `char_${crypto.randomUUID().slice(0, 8)}`,
        movieId: movie.id,
        ownerId: movie.ownerId,
        speakerLabel: (existing?.speakerLabel ?? item.speakerLabel ?? 'Speaker 1').slice(0, 64),
        characterName: (item.characterName ?? existing?.characterName ?? 'Character').trim().slice(0, 100),
        gender,
        genderConfidence: existing?.genderConfidence ?? 1,
        voiceProfileId,
        lineCount: existing?.lineCount ?? Number(item.lineCount ?? 0),
        sampleTurkish: (existing?.sampleTurkish ?? item.sampleTurkish ?? '').slice(0, 300),
        sampleUrdu: (existing?.sampleUrdu ?? item.sampleUrdu ?? '').slice(0, 300),
        updatedAt: new Date().toISOString(),
      };
    });

    const saved = updateMovieCharacters(movie.id, updatedChars)!;
    res.json({ movie: sanitizeMovieForClient(saved, true) });
  });

  // Protected Download & HTTP Range Media Streaming Endpoint
  app.get('/api/dubbing/:id/download', async (req: Request, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const typeParam = typeof req.query.type === 'string' ? req.query.type : 'mp4';
    const mediaType: 'mp4' | 'srt' | 'source' =
      typeParam === 'srt' ? 'srt' : typeParam === 'source' ? 'source' : 'mp4';

    const sigParam = typeof req.query.sig === 'string' ? req.query.sig : '';
    let authorized = false;

    if (sigParam && verifyDownloadUrlToken(movie.id, movie.ownerId, mediaType, sigParam)) {
      authorized = true;
    } else {
      const user = await resolveAuthFromRequest(req);
      if (user && user.uid === movie.ownerId) {
        authorized = true;
      }
    }

    if (!authorized) {
      res.status(403).json({ error: 'Unauthorized download access.' });
      return;
    }

    const filePath =
      mediaType === 'srt'
        ? movie.outputSrtPath
        : mediaType === 'source'
          ? movie.sourceVideoPath
          : movie.outputMp4Path;

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: `Requested ${mediaType.toUpperCase()} file is not available.` });
      return;
    }

    if (mediaType === 'srt') {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${movie.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_urdu.srt"`
      );
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    const isDownload = req.query.download === '1';

    if (isDownload) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${movie.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${mediaType === 'mp4' ? 'urdu_dubbed.mp4' : `source.${movie.format}`}"`
      );
    }

    const contentType =
      mediaType === 'source' && movie.format === 'mov'
        ? 'video/quicktime'
        : mediaType === 'source' && movie.format === 'mkv'
          ? 'video/x-matroska'
          : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const safeStart = Math.max(0, start);
      const safeEnd = Math.min(total - 1, end);
      const chunksize = safeEnd - safeStart + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${safeStart}-${safeEnd}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath, { start: safeStart, end: safeEnd }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Delete completed or failed project + all stored files
  app.delete('/api/movies/:id', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const movie = getMovie(req.params.id);
    if (!movie || movie.ownerId !== req.user!.uid) {
      res.status(404).json({ error: 'Movie project not found.' });
      return;
    }

    for (const file of [movie.sourceVideoPath, movie.outputMp4Path, movie.outputSrtPath]) {
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }

    deleteMovieRecord(movie.id);
    res.json({ deleted: true, id: movie.id });
  });

  // Vite middleware (dev) or static production serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`UrduDub AI server listening on http://0.0.0.0:${PORT}`);
    resumePendingJobsOnStartup();
  });
}

void startServer();
