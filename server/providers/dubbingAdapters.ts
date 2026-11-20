import fs from 'node:fs';
import { ThinkingLevel, Type } from '@google/genai';
import {
  URDU_VOICE_PROFILES,
  type CharacterGender,
  type CharacterProfile,
  type DialogueSegment,
  type UrduVoiceProfile,
} from '../types.ts';
import { getGeminiClient, hasGeminiKey, withRetry } from './geminiClient.ts';

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
  }): Promise<AsrDiarizedLine[]>;
}

export interface UrduTranslationProvider {
  readonly name: string;
  translateBatch(params: {
    lines: Array<{ index: number; speakerLabel: string; gender: CharacterGender; turkishText: string; emotion: string; durationSec: number }>;
    movieTitle: string;
  }): Promise<TranslationResultLine[]>;
}

export interface UrduTtsProvider {
  readonly name: string;
  synthesizeLine(params: {
    urduText: string;
    emotion: string;
    voiceProfile: UrduVoiceProfile;
    outWavPath: string;
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
  // Deterministic round-robin if cast exceeds preset count
  return pool[usedVoiceIds.size % pool.length].id;
}

let preferDirectMultimodalAsr = false;

export class GeminiTurkishAsrDiarizationAdapter implements TurkishAsrDiarizationProvider {
  readonly name = 'gemini-3.5-transcribe + gemini-4-hydrogen';

  async transcribeAndDiarizeChunk(params: {
    chunkAudioPath: string;
    chunkIndex: number;
    chunkStartSec: number;
    chunkEndSec: number;
    knownCharacters: CharacterProfile[];
  }): Promise<AsrDiarizedLine[]> {
    const ai = getGeminiClient();
    const audioBytes = fs.readFileSync(params.chunkAudioPath);
    const audioBase64 = audioBytes.toString('base64');

    const audioPart = {
      inlineData: {
        mimeType: 'audio/mp3',
        data: audioBase64,
      },
    };

    // Step A: Try dedicated Turkish transcription (12s abort timeout); if endpoint hits 504/timeout,
    // use gemini-4-hydrogen directly on audio for remaining chunks without losing 12s per chunk.
    let rawTranscript = '';
    if (!preferDirectMultimodalAsr) {
      try {
        const transcriptResp = await withRetry(
          () =>
            ai.models.generateContent({
              model: 'gemini-3.5-transcribe',
              contents: {
                parts: [
                  audioPart,
                  {
                    text: 'Transcribe all spoken Turkish dialogue in this film audio segment accurately in Turkish.',
                  },
                ],
              },
              config: {
                abortSignal: AbortSignal.timeout(12000),
              },
            }),
          { maxAttempts: 1, label: `transcribe_chunk_${params.chunkIndex}` }
        );
        rawTranscript = (transcriptResp.text ?? '').trim();
      } catch {
        preferDirectMultimodalAsr = true;
      }
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

    const chunkDuration = Math.max(1, params.chunkEndSec - params.chunkStartSec);

    const transcriptSection = rawTranscript
      ? `Reference Turkish transcript:\n"""\n${rawTranscript}\n"""\n`
      : 'Listen directly to the attached Turkish audio and transcribe every spoken Turkish line accurately.\n';

    // Step B: Structured timestamping + speaker diarization + gender confidence
    // Uses gemini-4-hydrogen with resilient fallback to gemini-3.1-flash-lite on 503 demand spikes
    const diarizePrompt = `Analyze this ${chunkDuration.toFixed(1)}s Turkish movie audio chunk (starting at ${params.chunkStartSec.toFixed(1)}s in the movie).
${transcriptSection}
Known recurring speaker roster from earlier scenes (reuse the exact speakerLabel whenever the same voice returns):
${rosterContext}

Return every spoken dialogue line with:
- startSec and endSec relative to THIS chunk's start (0.0 to ${chunkDuration.toFixed(1)}).
- speakerLabel: consistent identifier like "Speaker 1", "Speaker 2", etc.
- gender: "male", "female", or "unknown" (use "unknown" if unclear, child/ambiguous, or low confidence).
- genderConfidence: 0.0 to 1.0.
- turkishText: clean Turkish dialogue sentence.
- emotion: short tone label (e.g., "calm", "tense", "angry", "warm", "sad", "whispered").
Skip pure music/silence segments.`;

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

    let diarizedResp;
    try {
      diarizedResp = await withRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: { parts: [audioPart, { text: diarizePrompt }] },
            config: {
              abortSignal: AbortSignal.timeout(22000),
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: diarizeSchema,
            },
          }),
        { maxAttempts: 1, label: `diarize_chunk_${params.chunkIndex}` }
      );
    } catch {
      diarizedResp = await withRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: { parts: [audioPart, { text: diarizePrompt }] },
            config: {
              abortSignal: AbortSignal.timeout(25000),
              responseMimeType: 'application/json',
              responseSchema: diarizeSchema,
            },
          }),
        { maxAttempts: 2, label: `diarize_lite_chunk_${params.chunkIndex}` }
      );
    }

    const parsed = JSON.parse((diarizedResp.text ?? '[]').trim()) as Array<
      Partial<AsrDiarizedLine>
    >;

    return parsed
      .filter((item) => item.turkishText && item.turkishText.trim().length > 0)
      .map((item) => {
        const relStart = Math.max(0, Math.min(chunkDuration - 0.3, Number(item.startSec ?? 0)));
        const relEnd = Math.max(
          relStart + 0.5,
          Math.min(chunkDuration, Number(item.endSec ?? relStart + 2.5))
        );
        const normGender: CharacterGender =
          item.gender === 'male' || item.gender === 'female' ? item.gender : 'unknown';
        const conf = Math.min(1, Math.max(0, Number(item.genderConfidence ?? 0.6)));

        return {
          startSec: Number((params.chunkStartSec + relStart).toFixed(2)),
          endSec: Number((params.chunkStartSec + relEnd).toFixed(2)),
          speakerLabel: (item.speakerLabel || 'Speaker 1').trim(),
          gender: conf >= 0.55 ? normGender : 'unknown',
          genderConfidence: conf,
          turkishText: item.turkishText!.trim(),
          emotion: (item.emotion || 'natural').trim(),
        };
      });
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
  }): Promise<TranslationResultLine[]> {
    if (params.lines.length === 0) return [];
    const ai = getGeminiClient();

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
    try {
      response = await withRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: translationPrompt,
            config: {
              abortSignal: AbortSignal.timeout(22000),
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              systemInstruction: sysInst,
              responseMimeType: 'application/json',
              responseSchema: translationSchema,
            },
          }),
        { maxAttempts: 1, label: 'urdu_translation_batch' }
      );
    } catch {
      response = await withRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: translationPrompt,
            config: {
              abortSignal: AbortSignal.timeout(25000),
              systemInstruction: sysInst,
              responseMimeType: 'application/json',
              responseSchema: translationSchema,
            },
          }),
        { maxAttempts: 2, label: 'urdu_translation_lite_batch' }
      );
    }

    const parsed = JSON.parse((response.text ?? '[]').trim()) as Array<{
      index?: number;
      urduText?: string;
    }>;
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
  }): Promise<void> {
    const ai = getGeminiClient();
    const response = await withRetry(
      () =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
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
            abortSignal: AbortSignal.timeout(35000),
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: params.voiceProfile.geminiVoice,
                },
              },
            },
          },
        }),
      { label: `urdu_tts_${params.voiceProfile.id}` }
    );

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('Gemini TTS returned an empty audio payload.');
    }
    const wavBuffer = Buffer.from(base64Audio, 'base64');
    fs.writeFileSync(params.outWavPath, wavBuffer);
  }
}

export async function generateTurkishDualSpeakerSampleWav(outWavPath: string): Promise<void> {
  const ai = getGeminiClient();
  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
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
      }),
    { label: 'sample_turkish_tts' }
  );

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
      ? `${sttProvider} (gemini-3.5-transcribe)`
      : 'Not configured (GEMINI_API_KEY required)',
    diarizationProvider: geminiConfigured
      ? 'gemini-4-hydrogen audio diarizer'
      : 'Not configured (GEMINI_API_KEY required)',
    translationProvider: geminiConfigured
      ? 'gemini-4-hydrogen (Turkish -> Pakistani Urdu)'
      : 'Not configured (GEMINI_API_KEY required)',
    ttsProvider: geminiConfigured
      ? `${ttsProvider} (gemini-3.8-flash-lite-tts)`
      : 'Not configured (GEMINI_API_KEY required)',
    sourceSeparationProvider: sourceSepUrl
      ? `External Stem Separator (${sourceSepUrl})`
      : 'FFmpeg Mid-Side Dialogue Suppression + Sidechain Ducking',
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
