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
  | 'completed'
  | 'failed';

export type CharacterGender = 'male' | 'female' | 'unknown';

export interface UrduVoiceProfile {
  id: string;
  label: string;
  gender: 'male' | 'female';
  geminiVoice: 'Charon' | 'Fenrir' | 'Puck' | 'Kore' | 'Zephyr';
  pitchSemitones: number;
  stylePrompt: string;
  description: string;
}

export const URDU_VOICE_PROFILES: UrduVoiceProfile[] = [
  {
    id: 'urdu_male_a',
    label: 'Pakistani Urdu Male A — Tariq',
    gender: 'male',
    geminiVoice: 'Charon',
    pitchSemitones: 0,
    stylePrompt:
      'Natural Pakistani Urdu male film voice actor, warm authoritative baritone, crisp Lahore/Islamabad pronunciation, expressive cinematic pacing.',
    description: 'Warm authoritative baritone suited for lead male roles.',
  },
  {
    id: 'urdu_male_b',
    label: 'Pakistani Urdu Male B — Bilal',
    gender: 'male',
    geminiVoice: 'Fenrir',
    pitchSemitones: 0,
    stylePrompt:
      'Natural Pakistani Urdu male dramatic voice actor, deep resonant steady timber, emotional gravitas.',
    description: 'Deep resonant voice suited for dramatic or antagonist roles.',
  },
  {
    id: 'urdu_male_c',
    label: 'Pakistani Urdu Male C — Zain',
    gender: 'male',
    geminiVoice: 'Puck',
    pitchSemitones: 0,
    stylePrompt:
      'Young Pakistani Urdu male actor, natural conversational energy, agile expressive delivery.',
    description: 'Youthful agile voice for younger male characters.',
  },
  {
    id: 'urdu_male_d',
    label: 'Pakistani Urdu Male D — Kamran',
    gender: 'male',
    geminiVoice: 'Charon',
    pitchSemitones: -2.2,
    stylePrompt:
      'Mature elder Pakistani Urdu male speaker, calm measured wisdom, rich gravitas.',
    description: 'Lower-pitched mature timbre for elders and mentors.',
  },
  {
    id: 'urdu_female_a',
    label: 'Pakistani Urdu Female A — Ayesha',
    gender: 'female',
    geminiVoice: 'Kore',
    pitchSemitones: 0,
    stylePrompt:
      'Natural Pakistani Urdu female film actress, warm poised emotional delivery, authentic Pakistani Urdu intonation.',
    description: 'Warm expressive lead female voice.',
  },
  {
    id: 'urdu_female_b',
    label: 'Pakistani Urdu Female B — Sana',
    gender: 'female',
    geminiVoice: 'Zephyr',
    pitchSemitones: 0,
    stylePrompt:
      'Young Pakistani Urdu female speaker, bright clear articulation, natural conversational drama pacing.',
    description: 'Bright articulate voice for supporting or young female characters.',
  },
  {
    id: 'urdu_female_c',
    label: 'Pakistani Urdu Female C — Nadia',
    gender: 'female',
    geminiVoice: 'Kore',
    pitchSemitones: 1.8,
    stylePrompt:
      'Expressive Pakistani Urdu female character voice, crisp diction, dynamic emotional range.',
    description: 'Distinct higher-timbre female voice for multi-cast scenes.',
  },
];

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
  ttsWavPath?: string;
  timedWavPath?: string;
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
  stage: ProcessingStageName | 'System';
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
  currentStage: ProcessingStageName;
  stageIndex: number;
  progressPercent: number;
  etaSeconds: number | null;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  chunkStates: ChunkState[];
  characters: CharacterProfile[];
  segments: DialogueSegment[];
  logs: ProcessingLogEntry[];
  sourceVideoPath: string;
  outputMp4Path?: string;
  outputMp4SizeBytes?: number;
  outputSrtPath?: string;
  sourceSeparationMethod?: string;
  demoMode: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
}

export interface UploadSession {
  uploadId: string;
  ownerId: string;
  title: string;
  originalFilename: string;
  format: MovieFormat;
  expectedSizeBytes: number;
  receivedBytes: number;
  rightsConfirmed: boolean;
  tempFilePath: string;
  createdAt: string;
}

export interface StudioUser {
  uid: string;
  email: string;
  displayName: string;
  shortClipVerified: boolean;
  createdAt: string;
}
