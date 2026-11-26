import fs from 'node:fs';
import path from 'node:path';
import { createPartFromUri, ThinkingLevel, Type } from '@google/genai';
import {
  URDU_VOICE_PROFILES,
  type CharacterGender,
  type CharacterProfile,
  type DialogueSegment,
  type UrduVoiceProfile,
} from '../types.ts';
import {
  classifyGeminiError,
  getGeminiClient,
  hasGeminiKey,
  JobCancelledError,
  QuotaExhaustedError,
} from './geminiClient.ts';
import {
  executeQueuedGeminiCall,
  getNextPtMidnightIso,
  getQuotaDiagnostics,
  isModelQuotaAvailable,
} from './quotaManager.ts';
import { extractSingleChunkAudio } from './ffmpegPipeline.ts';

export interface AsrDiarizedLine {
  startSec: number;
  endSec: number;
  speakerLabel: string;
  gender: CharacterGender;
  genderConfidence: number;
  turkishText: string;
  emotion: string;
}

export interface TranslationResultLine {
  index: number;
  urduText: string;
}

export interface TurkishAsrDiarizationProvider {
  readonly name: string;
  transcribeAndDiarizeChunk(params: {
    chunkAudioPath: string;
    chunkIndex: number;
    chunkStartSec: number;
    chunkEndSec: number;
    knownCharacters: CharacterProfile[];
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<AsrDiarizedLine[]>;
}

export interface UrduTranslationProvider {
  readonly name: string;
  translateBatch(params: {
    lines: Array<{
      index: number;
      speakerLabel: string;
      gender: CharacterGender;
      turkishText: string;
      emotion: string;
      durationSec: number;
    }>;
    movieTitle: string;
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<TranslationResultLine[]>;
}

export interface UrduTtsProvider {
  readonly name: string;
  synthesizeLine(params: {
    urduText: string;
    emotion: string;
    voiceProfile: UrduVoiceProfile;
    outWavPath: string;
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<void>;
}

export function pickVoiceProfileForSpeaker(
  gender: CharacterGender,
  genderConfidence: number,
  usedVoiceIds: Set<string>
): string {
  const effectiveGender = gender === 'female' && genderConfidence >= 0.55 ? 'female' : 'male';
  const pool = URDU_VOICE_PROFILES.filter((v) => v.gender === effectiveGender);
  const unused = pool.find((v) => !usedVoiceIds.has(v.id));
  if (unused) return unused.id;
  return pool[usedVoiceIds.size % pool.length].id;
}

function normalizeTextForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenJaccardSimilarity(a: string, b: string): number {
  const na = normalizeTextForComparison(a);
  const nb = normalizeTextForComparison(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const setA = new Set(na.split(' '));
  const setB = new Set(nb.split(' '));
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function deduplicateBoundaryLines<T extends { startSec: number; endSec: number; turkishText: string }>(
  existing: T[],
  incoming: T[]
): T[] {
  if (existing.length === 0) return [...incoming];
  const recentTail = existing.slice(-6);
  const lastPrevEnd = existing[existing.length - 1].endSec;
  const accepted: T[] = [];

  for (const line of incoming) {
    // Check if an existing tail line near the overlap boundary matches or was cut mid-sentence
    let isDuplicate = false;
    for (const prev of recentTail) {
      const timeDiff = Math.abs(line.startSec - prev.startSec);
      const overlapsInTime = line.startSec < prev.endSec - 0.25 && line.endSec > prev.startSec + 0.25;
      const sim = tokenJaccardSimilarity(line.turkishText, prev.turkishText);

      if ((overlapsInTime || timeDiff <= 2.5) && sim >= 0.65) {
        // If previous line ended right on chunk boundary and incoming has longer complete sentence, extend prev instead of duplicating
        if (
          line.endSec > prev.endSec + 1.0 &&
          line.turkishText.length > prev.turkishText.length + 8
        ) {
          prev.endSec = line.endSec;
          prev.turkishText = line.turkishText;
        }
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) continue;

    // Also skip lines strictly before the previous chunk's last completed end unless genuinely distinct later speech
    if (line.startSec < lastPrevEnd - 0.6 && line.endSec <= lastPrevEnd + 0.3) {
      continue;
    }

    accepted.push(line);
  }

  return accepted;
}

function parseJsonArraySafe<T>(rawText: string | undefined): T[] {
  let text = (rawText ?? '').trim();
  if (!text) return [];
  // Strip optional markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  }
  const startIdx = text.indexOf('[');
  const endIdx = text.lastIndexOf(']');
  if (startIdx >= 0 && endIdx > startIdx) {
    text = text.slice(startIdx, endIdx + 1);
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

const INLINE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB; larger audio chunks use Gemini Files API

async function prepareAudioPart(
  ai: ReturnType<typeof getGeminiClient>,
  audioPath: string
): Promise<{ part: Record<string, unknown>; cleanup: () => Promise<void> }> {
  const stat = fs.statSync(audioPath);
  if (stat.size <= INLINE_MAX_BYTES) {
    const audioBase64 = fs.readFileSync(audioPath).toString('base64');
    return {
      part: {
        inlineData: {
          mimeType: 'audio/mp3',
          data: audioBase64,
        },
      },
      cleanup: async () => {},
    };
  }

  const uploaded = await ai.files.upload({
    file: audioPath,
    config: { mimeType: 'audio/mp3' },
  });

  // Poll until file state is ACTIVE (if processing)
  let fileName = uploaded.name;
  let fileUri = uploaded.uri;
  let mimeType = uploaded.mimeType ?? 'audio/mp3';
  if (fileName && uploaded.state === 'PROCESSING') {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const check = await ai.files.get({ name: fileName });
      if (check.state === 'ACTIVE') {
        fileUri = check.uri;
        mimeType = check.mimeType ?? mimeType;
        break;
      }
      if (check.state === 'FAILED') {
        throw new Error('Gemini Files API failed while preparing audio chunk.');
      }
    }
  }

  if (!fileUri) {
    throw new Error('Gemini Files API did not return a valid URI for audio chunk.');
  }

  return {
    part: createPartFromUri(fileUri, mimeType) as unknown as Record<string, unknown>,
    cleanup: async () => {
      if (fileName) {
        try {
          await ai.files.delete({ name: fileName });
        } catch {
          // Non-fatal cleanup
        }
      }
    },
  };
}

export class GeminiTurkishAsrDiarizationAdapter implements TurkishAsrDiarizationProvider {
  readonly name = 'gemini-3.5-transcribe + gemini-4-hydrogen';

  async transcribeAndDiarizeChunk(params: {
    chunkAudioPath: string;
    chunkIndex: number;
    chunkStartSec: number;
    chunkEndSec: number;
    knownCharacters: CharacterProfile[];
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<AsrDiarizedLine[]> {
    if (params.shouldCancel?.()) {
      throw new JobCancelledError();
    }

    if (!fs.existsSync(params.chunkAudioPath)) {
      throw new Error(`Audio chunk file missing on disk: ${params.chunkAudioPath}`);
    }

    const chunkDuration = Math.max(1, params.chunkEndSec - params.chunkStartSec);

    // Sub-window safeguard: if an existing/legacy chunk exceeds 135 seconds (e.g. 300s Chunk 2),
    // split it internally into <= 90s sub-windows with 6s overlap so each Gemini call stays fast & reliable.
    if (chunkDuration > 135) {
      const subWindowSec = 90;
      const subOverlapSec = 6;
      const subDir = path.join(path.dirname(params.chunkAudioPath), `sub_${params.chunkIndex}`);
      fs.mkdirSync(subDir, { recursive: true });

      const mergedLines: AsrDiarizedLine[] = [];
      let subCursor = 0;
      let subIdx = 0;

      try {
        while (subCursor < chunkDuration) {
          if (params.shouldCancel?.()) {
            throw new JobCancelledError();
          }
          const relStart = Math.max(0, subCursor - (subIdx > 0 ? subOverlapSec : 0));
          const relEnd = Math.min(chunkDuration, subCursor + subWindowSec);
          const subPath = path.join(subDir, `sub_${subIdx}.mp3`);

          await extractSingleChunkAudio(params.chunkAudioPath, relStart, relEnd, subPath);
          const subLines = await this.processSingleWindow({
            windowAudioPath: subPath,
            windowLabel: `${params.chunkIndex + 1}.${subIdx + 1}`,
            windowStartSec: params.chunkStartSec + relStart,
            windowDurationSec: relEnd - relStart,
            knownCharacters: params.knownCharacters,
            shouldCancel: params.shouldCancel,
            onLog: params.onLog,
          });

          const fresh = deduplicateBoundaryLines(mergedLines, subLines);
          mergedLines.push(...fresh);

          if (relEnd >= chunkDuration) break;
          subCursor += subWindowSec;
          subIdx += 1;
        }
        return mergedLines;
      } finally {
        try {
          fs.rmSync(subDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure
        }
      }
    }

    return this.processSingleWindow({
      windowAudioPath: params.chunkAudioPath,
      windowLabel: `${params.chunkIndex + 1}`,
      windowStartSec: params.chunkStartSec,
      windowDurationSec: chunkDuration,
      knownCharacters: params.knownCharacters,
      shouldCancel: params.shouldCancel,
      onLog: params.onLog,
    });
  }

  private async processSingleWindow(params: {
    windowAudioPath: string;
    windowLabel: string;
    windowStartSec: number;
    windowDurationSec: number;
    knownCharacters: CharacterProfile[];
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<AsrDiarizedLine[]> {
    const ai = getGeminiClient(180_000);
    const { part: audioPart, cleanup } = await prepareAudioPart(ai, params.windowAudioPath);

    try {
      // Step A: Dedicated Turkish ASR using gemini-3.5-transcribe if quota is available today
      let rawTranscript = '';
      if (isModelQuotaAvailable('gemini-3.5-transcribe')) {
        try {
          const transcriptResp = await executeQueuedGeminiCall({
            model: 'gemini-3.5-transcribe',
            label: `transcribe_win_${params.windowLabel}`,
            maxTransientAttempts: 1,
            shouldCancel: params.shouldCancel,
            onLog: params.onLog,
            fn: () =>
              ai.models.generateContent({
                model: 'gemini-3.5-transcribe',
                contents: {
                  parts: [
                    audioPart,
                    {
                      text: 'Transcribe all spoken Turkish (Türkçe) dialogue in this movie audio clip verbatim in Turkish. Skip pure music and silence.',
                    },
                  ],
                },
                config: {
                  abortSignal: AbortSignal.timeout(45_000),
                },
              }),
          });
          rawTranscript = (transcriptResp.text ?? '').trim();
        } catch (asrErr) {
          const classified = classifyGeminiError(asrErr);
          if (classified.category === 'cancelled' || classified.category === 'permanent') {
            throw asrErr;
          }
          params.onLog?.(
            'warn',
            `Chunk ${params.windowLabel}: primary ASR (${classified.message.slice(0, 120)}), using direct multimodal audio transcription.`
          );
        }
      }

      if (params.shouldCancel?.()) {
        throw new JobCancelledError();
      }

      const rosterContext =
        params.knownCharacters.length > 0
          ? params.knownCharacters
              .map(
                (c) =>
                  `- ${c.speakerLabel} (${c.characterName}, gender=${c.gender}, sample="${c.sampleTurkish.slice(0, 80)}")`
              )
              .join('\n')
          : 'None detected yet — start numbering from Speaker 1, Speaker 2, etc.';

      const transcriptSection = rawTranscript
        ? `Reference Turkish transcript:\n"""\n${rawTranscript}\n"""\n`
        : 'Listen directly to the attached Turkish audio and transcribe ONLY genuinely audible spoken Turkish dialogue sentences. If there is no clear spoken human Turkish speech (silence, ambient tone, SFX, or music only), return an empty JSON array []. NEVER invent or guess dialogue.\n';

      const diarizePrompt = `Analyze this ${params.windowDurationSec.toFixed(1)}s Turkish (Türkçe) movie audio clip (timestamps strictly from 0.0 to ${params.windowDurationSec.toFixed(1)} seconds).
${transcriptSection}
Known recurring speaker roster from earlier scenes (reuse the exact speakerLabel whenever the same voice returns):
${rosterContext}

Return every genuinely spoken dialogue line as a JSON array with:
- startSec and endSec relative to THIS clip's start (strictly 0.0 to ${params.windowDurationSec.toFixed(1)}).
- speakerLabel: consistent identifier like "Speaker 1", "Speaker 2", etc.
- gender: "male", "female", or "unknown" (use "unknown" if unclear, child/ambiguous, or low confidence).
- genderConfidence: 0.0 to 1.0.
- turkishText: complete, accurate Turkish dialogue sentence (do not cut sentences mid-word).
- emotion: short tone label (e.g., "calm", "tense", "angry", "warm", "sad", "whispered").
If no Turkish speech is spoken in this clip, return [].`;

      const diarizeSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            startSec: { type: Type.NUMBER },
            endSec: { type: Type.NUMBER },
            speakerLabel: { type: Type.STRING },
            gender: { type: Type.STRING },
            genderConfidence: { type: Type.NUMBER },
            turkishText: { type: Type.STRING },
            emotion: { type: Type.STRING },
          },
        },
      };

      // Step B: Structured timestamping + speaker diarization + gender identification
      let diarizedResp;
      if (isModelQuotaAvailable('gemini-4-hydrogen')) {
        try {
          diarizedResp = await executeQueuedGeminiCall({
            model: 'gemini-4-hydrogen',
            label: `diarize_win_${params.windowLabel}`,
            maxTransientAttempts: 1,
            shouldCancel: params.shouldCancel,
            onLog: params.onLog,
            fn: () =>
              ai.models.generateContent({
                model: 'gemini-4-hydrogen',
                contents: { parts: [audioPart, { text: diarizePrompt }] },
                config: {
                  abortSignal: AbortSignal.timeout(120_000),
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                  maxOutputTokens: 8192,
                  responseMimeType: 'application/json',
                  responseSchema: diarizeSchema,
                },
              }),
          });
        } catch (primaryErr) {
          const classified = classifyGeminiError(primaryErr);
          if (classified.category === 'cancelled' || classified.category === 'permanent') {
            throw primaryErr;
          }
          params.onLog?.(
            'warn',
            `Chunk ${params.windowLabel}: gemini-4-hydrogen diarization unavailable (${classified.message.slice(0, 120)}), switching to gemini-3.1-flash-lite.`
          );
        }
      }

      if (!diarizedResp) {
        diarizedResp = await executeQueuedGeminiCall({
          model: 'gemini-3.1-flash-lite',
          label: `diarize_lite_win_${params.windowLabel}`,
          maxTransientAttempts: 4,
          shouldCancel: params.shouldCancel,
          onLog: params.onLog,
          fn: () =>
            ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: { parts: [audioPart, { text: diarizePrompt }] },
              config: {
                abortSignal: AbortSignal.timeout(120_000),
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
                responseSchema: diarizeSchema,
              },
            }),
        });
      }

      const parsed = parseJsonArraySafe<Partial<AsrDiarizedLine>>(diarizedResp.text);

      return parsed
        .filter((item) => item.turkishText && item.turkishText.trim().length > 1)
        .map((item) => {
          let rawStart = Number(item.startSec ?? 0);
          let rawEnd = Number(item.endSec ?? rawStart + 2.5);
          // Safety guard if a model ever returns movie-absolute timestamps instead of clip-relative timestamps
          if (
            params.windowStartSec > 0 &&
            rawStart > params.windowDurationSec &&
            rawStart >= params.windowStartSec &&
            rawStart <= params.windowStartSec + params.windowDurationSec
          ) {
            rawStart -= params.windowStartSec;
            rawEnd -= params.windowStartSec;
          }

          const relStart = Math.max(
            0,
            Math.min(params.windowDurationSec - 0.3, rawStart)
          );
          const relEnd = Math.max(
            relStart + 0.5,
            Math.min(params.windowDurationSec, rawEnd)
          );
          const normGender: CharacterGender =
            item.gender === 'male' || item.gender === 'female' ? item.gender : 'unknown';
          const conf = Math.min(1, Math.max(0, Number(item.genderConfidence ?? 0.6)));

          return {
            startSec: Number((params.windowStartSec + relStart).toFixed(2)),
            endSec: Number((params.windowStartSec + relEnd).toFixed(2)),
            speakerLabel: (item.speakerLabel || 'Speaker 1').trim(),
            gender: conf >= 0.55 ? normGender : 'unknown',
            genderConfidence: conf,
            turkishText: item.turkishText!.trim(),
            emotion: (item.emotion || 'natural').trim(),
          };
        })
        .sort((a, b) => a.startSec - b.startSec);
    } finally {
      await cleanup();
    }
  }
}

export class GeminiUrduTranslationAdapter implements UrduTranslationProvider {
  readonly name = 'gemini-4-hydrogen (Turkish -> Pakistani Urdu)';

  async translateBatch(params: {
    lines: Array<{
      index: number;
      speakerLabel: string;
      gender: CharacterGender;
      turkishText: string;
      emotion: string;
      durationSec: number;
    }>;
    movieTitle: string;
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<TranslationResultLine[]> {
    if (params.lines.length === 0) return [];
    const ai = getGeminiClient(120_000);

    const promptLines = params.lines
      .map(
        (l) =>
          `[${l.index}] (${l.speakerLabel}, gender=${l.gender}, emotion=${l.emotion}, window=${l.durationSec.toFixed(1)}s): "${l.turkishText}"`
      )
      .join('\n');

    const translationPrompt = `Translate the following Turkish movie dialogue lines from "${params.movieTitle}" into natural, idiomatic Pakistani Urdu (اردو) suitable for cinema voice dubbing.

Guidelines:
- Use authentic Pakistani Urdu spoken phrasing (not overly stiff archaic Persianized prose).
- Match speaker gender grammar accurately (e.g. رہا ہوں vs رہی ہوں, کرتا vs کرتی).
- Preserve Turkish proper names (e.g., Ertuğrul, Osman, Mehmet, Elif, Halime) in Urdu script cleanly.
- Keep sentence length proportional to the available speaking window in seconds so lip/timing alignment stays natural.
- Return Urdu script only in "urduText".

Lines:
${promptLines}`;

    const translationSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          urduText: { type: Type.STRING },
        },
      },
    };

    const sysInst =
      'You are a senior Pakistani film dialogue writer and Turkish-to-Urdu localization director.';

    let response;
    if (isModelQuotaAvailable('gemini-4-hydrogen')) {
      try {
        response = await executeQueuedGeminiCall({
          model: 'gemini-4-hydrogen',
          label: 'urdu_translation_batch',
          maxTransientAttempts: 1,
          shouldCancel: params.shouldCancel,
          onLog: params.onLog,
          fn: () =>
            ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: translationPrompt,
              config: {
                abortSignal: AbortSignal.timeout(90_000),
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                maxOutputTokens: 8192,
                systemInstruction: sysInst,
                responseMimeType: 'application/json',
                responseSchema: translationSchema,
              },
            }),
        });
      } catch (err) {
        const classified = classifyGeminiError(err);
        if (classified.category === 'cancelled' || classified.category === 'permanent') {
          throw err;
        }
      }
    }

    if (!response) {
      response = await executeQueuedGeminiCall({
        model: 'gemini-3.1-flash-lite',
        label: 'urdu_translation_lite_batch',
        maxTransientAttempts: 4,
        shouldCancel: params.shouldCancel,
        onLog: params.onLog,
        fn: () =>
          ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: translationPrompt,
            config: {
              abortSignal: AbortSignal.timeout(90_000),
              maxOutputTokens: 8192,
              systemInstruction: sysInst,
              responseMimeType: 'application/json',
              responseSchema: translationSchema,
            },
          }),
      });
    }

    const parsed = parseJsonArraySafe<{ index?: number; urduText?: string }>(response.text);
    return parsed.map((item, i) => ({
      index: typeof item.index === 'number' ? item.index : params.lines[i]?.index ?? i,
      urduText: (item.urduText ?? '').trim(),
    }));
  }
}

export class GeminiUrduTtsAdapter implements UrduTtsProvider {
  readonly name = 'gemini-3.8-flash-lite-tts';

  async synthesizeLine(params: {
    urduText: string;
    emotion: string;
    voiceProfile: UrduVoiceProfile;
    outWavPath: string;
    shouldCancel?: () => boolean;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  }): Promise<void> {
    const ai = getGeminiClient(120_000);
    const buildReq = (model: 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts') =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: params.urduText,
                speechMetadata: {
                  style: `${params.voiceProfile.stylePrompt} Emotion: ${params.emotion}.`,
                },
              },
            ],
          },
        ],
        config: {
          abortSignal: AbortSignal.timeout(60_000),
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: params.voiceProfile.geminiVoice,
              },
            },
          },
        },
      });

    let response;
    let lastQuotaErr: QuotaExhaustedError | null = null;

    const candidateModels: Array<'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'> = [
      'gemini-3.8-flash-lite-tts',
      'gemini-3.8-flash-tts',
    ];

    for (const model of candidateModels) {
      if (!isModelQuotaAvailable(model)) {
        continue;
      }
      try {
        response = await executeQueuedGeminiCall({
          model,
          label: `urdu_tts_${model}_${params.voiceProfile.id}`,
          maxTransientAttempts: 4,
          shouldCancel: params.shouldCancel,
          onLog: params.onLog,
          fn: () => buildReq(model),
        });
        break;
      } catch (err) {
        if (err instanceof QuotaExhaustedError) {
          lastQuotaErr = err;
          params.onLog?.(
            'warn',
            `${model} daily quota reached; checking remaining Free Tier TTS model availability.`
          );
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      if (lastQuotaErr) {
        throw lastQuotaErr;
      }
      throw new QuotaExhaustedError(
        candidateModels.join(' / '),
        getNextPtMidnightIso(),
        'All configured Gemini Free Tier TTS models have reached their daily quota. Processing paused safely.'
      );
    }

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('Gemini TTS returned an empty audio payload.');
    }
    const wavBuffer = Buffer.from(base64Audio, 'base64');
    if (wavBuffer.length <= 44) {
      throw new Error('Gemini TTS returned an invalid WAV header without audio samples.');
    }
    fs.writeFileSync(params.outWavPath, wavBuffer);
  }
}

export async function generateTurkishDualSpeakerSampleWav(outWavPath: string): Promise<void> {
  const ai = getGeminiClient(120_000);
  const candidateModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
  const buildReq = (model: string) =>
    ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Mehmet: Elif, İstanbul treni birazdan kalkacak, çabuk olmalıyız.',
              speechMetadata: {
                speaker: 'Mehmet',
                style: 'Urgent, warm Turkish male cinema lead',
              },
            },
            {
              text: 'Elif: Hazırım Mehmet, babamın mektubunu yanıma aldım. Hadi gidelim!',
              speechMetadata: {
                speaker: 'Elif',
                style: 'Determined, expressive Turkish female lead',
              },
            },
            {
              text: 'Mehmet: Güzel, bu gece tüm gerçeği öğreneceğiz.',
              speechMetadata: {
                speaker: 'Mehmet',
                style: 'Calm, resolute tone',
              },
            },
          ],
        },
      ],
      config: {
        abortSignal: AbortSignal.timeout(60_000),
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: 'Mehmet',
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
              },
              {
                speaker: 'Elif',
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
              },
            ],
          },
        },
      },
    });

  let response: Awaited<ReturnType<typeof buildReq>> | null = null;
  let lastQuotaErr: QuotaExhaustedError | null = null;

  for (const model of candidateModels) {
    if (!isModelQuotaAvailable(model)) continue;
    try {
      response = await executeQueuedGeminiCall({
        model,
        label: `sample_turkish_tts:${model}`,
        maxTransientAttempts: 3,
        fn: () => buildReq(model),
      });
      break;
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        lastQuotaErr = err;
        continue;
      }
      throw err;
    }
  }

  if (!response) {
    if (lastQuotaErr) throw lastQuotaErr;
    throw new QuotaExhaustedError(
      candidateModels.join(' / '),
      getNextPtMidnightIso(),
      'All configured Gemini Free Tier TTS models have reached their daily quota.'
    );
  }

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Could not synthesize sample Turkish audio from Gemini TTS.');
  }
  fs.writeFileSync(outWavPath, Buffer.from(base64Audio, 'base64'));
}

export function getProviderDiagnostics() {
  const geminiConfigured = hasGeminiKey();
  const sourceSepUrl = process.env.SOURCE_SEPARATION_URL?.trim() || null;
  const sttProvider = process.env.EXTERNAL_STT_PROVIDER?.trim() || 'gemini';
  const ttsProvider = process.env.EXTERNAL_TTS_PROVIDER?.trim() || 'gemini';

  return {
    geminiConfigured,
    asrProvider: geminiConfigured
      ? `${sttProvider} (gemini-3.5-transcribe / gemini-4-hydrogen)`
      : 'Not configured (GEMINI_API_KEY required)',
    diarizationProvider: geminiConfigured
      ? 'gemini-4-hydrogen audio diarizer'
      : 'Not configured (GEMINI_API_KEY required)',
    translationProvider: geminiConfigured
      ? 'gemini-4-hydrogen (Turkish -> Pakistani Urdu)'
      : 'Not configured (GEMINI_API_KEY required)',
    ttsProvider: geminiConfigured
      ? `${ttsProvider} (gemini-3.8-flash-lite-tts / gemini-3.8-flash-tts)`
      : 'Not configured (GEMINI_API_KEY required)',
    sourceSeparationProvider: sourceSepUrl
      ? `External Stem Separator (${sourceSepUrl})`
      : 'FFmpeg Mid-Side Dialogue Suppression + Sidechain Ducking',
    quota: getQuotaDiagnostics(),
  };
}

export function buildDemoSegmentsForDuration(durationSec: number): DialogueSegment[] {
  const safeDur = Math.max(6, Math.min(durationSec, 30));
  const slice = safeDur / 3;
  return [
    {
      id: 'demo-seg-1',
      chunkIndex: 0,
      startSec: 0.4,
      endSec: Number((slice - 0.3).toFixed(2)),
      speakerId: 'speaker_1',
      speakerLabel: 'Speaker 1',
      gender: 'male',
      genderConfidence: 0.94,
      turkishText: 'Demo Modu: Bu sahne yalnızca sistem önizlemesi içindir.',
      urduText: 'ڈیمو موڈ: یہ منظر صرف سسٹم کے پیش نظارہ کے لیے ہے۔',
      emotion: 'calm',
      voiceProfileId: 'urdu_male_a',
    },
    {
      id: 'demo-seg-2',
      chunkIndex: 0,
      startSec: Number((slice + 0.2).toFixed(2)),
      endSec: Number((slice * 2 - 0.3).toFixed(2)),
      speakerId: 'speaker_2',
      speakerLabel: 'Speaker 2',
      gender: 'female',
      genderConfidence: 0.92,
      turkishText: 'Gerçek dublaj için Gemini API anahtarının tanımlı olması gerekir.',
      urduText: 'حقیقی ڈبنگ کے لیے سرور پر جیمینائی اے آئی کی کا فعال ہونا ضروری ہے۔',
      emotion: 'informative',
      voiceProfileId: 'urdu_female_a',
    },
    {
      id: 'demo-seg-3',
      chunkIndex: 0,
      startSec: Number((slice * 2 + 0.2).toFixed(2)),
      endSec: Number((safeDur - 0.4).toFixed(2)),
      speakerId: 'speaker_1',
      speakerLabel: 'Speaker 1',
      gender: 'male',
      genderConfidence: 0.94,
      turkishText: 'Karakter sesleri film boyunca aynı kalır.',
      urduText: 'ہر کردار کی آواز پوری فلم میں ایک جیسی برقرار رہتی ہے۔',
      emotion: 'confident',
      voiceProfileId: 'urdu_male_a',
    },
  ];
}
