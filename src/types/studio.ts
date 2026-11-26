export const PROCESSING_STAGES = [
  'Uploading movie',
  'Extracting audio',
  'Detecting Turkish speech',
  'Transcribing dialogue',
  'Identifying speakers',
  'Translating Turkish into Urdu',
  'Generating Urdu voices',
  'Synchronizing dialogue',
  'Mixing audio',
  'Rendering final MP4',
] as const;

export type ProcessingStageName = (typeof PROCESSING_STAGES)[number];

export type MovieFormat = 'mp4' | 'mov' | 'mkv';
export type MovieStatus =
  | 'uploaded'
  | 'scanning'
  | 'ready_for_dubbing'
  | 'queued'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed';

export type PauseReason = 'quota_exhausted' | 'user_paused';

export type CharacterGender = 'male' | 'female' | 'unknown';

export interface UrduVoiceProfile {
  id: string;
  label: string;
  gender: 'male' | 'female';
  geminiVoice: string;
  pitchSemitones: number;
  stylePrompt: string;
  description: string;
}

export interface CharacterProfile {
  id: string;
  movieId: string;
  ownerId: string;
  speakerLabel: string;
  characterName: string;
  gender: CharacterGender;
  genderConfidence: number;
  voiceProfileId: string;
  lineCount: number;
  sampleTurkish: string;
  sampleUrdu: string;
  updatedAt: string;
}

export interface DialogueSegment {
  id: string;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  speakerId: string;
  speakerLabel: string;
  gender: CharacterGender;
  genderConfidence: number;
  turkishText: string;
  urduText: string;
  emotion: string;
  voiceProfileId: string;
  ttsStatus?: 'pending' | 'processing' | 'completed' | 'failed';
  ttsAttempts?: number;
  ttsError?: string;
  ttsVoiceProfileId?: string;
  ttsCompletedAt?: string;
}

export interface ChunkState {
  index: number;
  startSec: number;
  endSec: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  durationMs?: number;
  error?: string;
}

export interface ProcessingLogEntry {
  id: string;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  createdAt: string;
}

export interface MovieProject {
  id: string;
  ownerId: string;
  title: string;
  originalFilename: string;
  format: MovieFormat;
  fileSizeBytes: number;
  durationSeconds: number;
  width?: number;
  height?: number;
  sourceLang: 'tr';
  targetLang: 'ur-PK';
  rightsConfirmed: boolean;
  status: MovieStatus;
  targetMode?: 'scan' | 'full';
  pauseReason?: PauseReason;
  pausedAt?: string;
  quotaResetAt?: string;
  currentStage: ProcessingStageName;
  stageIndex: number;
  progressPercent: number;
  etaSeconds: number | null;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  totalTtsChunks?: number;
  completedTtsChunks?: number;
  failedTtsChunks?: number;
  remainingTtsChunks?: number;
  chunkStates: ChunkState[];
  characters: CharacterProfile[];
  segmentsCount: number;
  segments?: DialogueSegment[];
  logs: ProcessingLogEntry[];
  outputMp4SizeBytes?: number;
  sourceSeparationMethod?: string;
  demoMode: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  sourcePreviewUrl: string;
  downloadMp4Url: string | null;
  downloadSrtUrl: string | null;
}

export interface DashboardStats {
  total: number;
  processing: number;
  paused?: number;
  completed: number;
  failed: number;
}

export interface QuotaModelDiagnostic {
  model: string;
  datePt: string;
  requestCount: number;
  configuredOrObservedLimit: number | null;
  exhaustedToday: boolean;
  exhaustedUntilIso: string | null;
}

export interface QuotaDiagnostics {
  ptDate: string;
  nextResetIso: string;
  allTtsExhaustedToday: boolean;
  models: QuotaModelDiagnostic[];
}

export interface ProviderHealth {
  geminiConfigured: boolean;
  asrProvider: string;
  diarizationProvider: string;
  translationProvider: string;
  ttsProvider: string;
  sourceSeparationProvider: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  firebaseConfigured: boolean;
  quota?: QuotaDiagnostics;
  limits: {
    maxUploadGb: number;
    maxUploadBytes: number;
    maxDurationMinutes: number;
    shortClipTestMinutes: number;
    supportedFormats: string[];
  };
}

export interface StudioUserSession {
  uid: string;
  email: string;
  displayName: string;
  shortClipVerified: boolean;
  authMode: 'firebase' | 'studio-local';
}
