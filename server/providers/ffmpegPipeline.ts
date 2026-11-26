import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DialogueSegment } from '../types.ts';

export interface VideoProbeInfo {
  durationSeconds: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
}

export interface ExtractedChunk {
  index: number;
  startSec: number;
  endSec: number;
  audioPath: string;
}

function runProcess(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      // Limit stderr buffer to last 16KB for long 3-hour renders
      stderr = (stderr + d.toString()).slice(-16384);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(-800)}`));
      }
    });
  });
}

export async function checkFfmpegAvailable(): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  const check = async (bin: string) => {
    try {
      await runProcess(bin, ['-version']);
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')]);
  return { ffmpeg, ffprobe };
}

export async function probeVideo(filePath: string): Promise<VideoProbeInfo> {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      channels?: number;
      duration?: string;
    }>;
  };
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationSeconds = Number(
    parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0
  );

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    width: videoStream?.width,
    height: videoStream?.height,
    hasAudio: Boolean(audioStream),
    hasVideo: Boolean(videoStream),
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    channels: audioStream?.channels,
  };
}

export async function probeAudioDuration(wavPath: string): Promise<number> {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    wavPath,
  ]);
  const dur = Number(stdout.trim());
  return Number.isFinite(dur) ? dur : 0;
}

export async function extractFullStereoAudio(
  moviePath: string,
  outWavPath: string
): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    moviePath,
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    outWavPath,
  ]);
}

export async function extractBackgroundBed(
  fullStereoWavPath: string,
  outBgWavPath: string,
  channels = 2
): Promise<void> {
  // Attenuate center-panned vocal energy while retaining stereo music & ambient SFX
  // When source audio is stereo, mid-side subtraction removes center dialogue cleanly.
  const filter =
    channels >= 2
      ? 'stereotools=mlev=0.22:slev=1.15,highpass=f=45,lowpass=f=16000'
      : 'bandreject=f=1200:width_type=h:w=1800,volume=0.35';

  await runProcess('ffmpeg', [
    '-y',
    '-i',
    fullStereoWavPath,
    '-af',
    filter,
    '-acodec',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    outBgWavPath,
  ]);
}

export async function extractSingleChunkAudio(
  sourceAudioPath: string,
  startSec: number,
  endSec: number,
  outMp3Path: string
): Promise<void> {
  fs.mkdirSync(path.dirname(outMp3Path), { recursive: true });
  const clipDuration = Math.max(0.5, endSec - startSec);
  await runProcess('ffmpeg', [
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-t',
    clipDuration.toFixed(3),
    '-i',
    sourceAudioPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '48k',
    outMp3Path,
  ]);
}

export async function splitAudioIntoChunks(
  sourceAudioPath: string,
  chunksDir: string,
  totalDurationSec: number,
  chunkSeconds = 90,
  overlapSeconds = 6,
  reuseExisting = false
): Promise<ExtractedChunk[]> {
  fs.mkdirSync(chunksDir, { recursive: true });
  const chunks: ExtractedChunk[] = [];
  let index = 0;
  let cursor = 0;

  while (cursor < totalDurationSec) {
    const startSec = Math.max(0, cursor - (index > 0 ? overlapSeconds : 0));
    const nominalEnd = Math.min(totalDurationSec, cursor + chunkSeconds);
    const outMp3 = path.join(chunksDir, `chunk_${String(index).padStart(4, '0')}.mp3`);

    const existsValid =
      reuseExisting && fs.existsSync(outMp3) && fs.statSync(outMp3).size > 512;
    if (!existsValid) {
      await extractSingleChunkAudio(sourceAudioPath, startSec, nominalEnd, outMp3);
    }

    chunks.push({
      index,
      startSec,
      endSec: nominalEnd,
      audioPath: outMp3,
    });

    if (nominalEnd >= totalDurationSec) break;
    cursor += chunkSeconds;
    index += 1;
  }

  return chunks;
}

export async function fitSegmentTiming(
  rawWavPath: string,
  outWavPath: string,
  targetDurationSec: number,
  pitchSemitones = 0
): Promise<number> {
  // Step 1: Trim silence from generated TTS WAV so timing alignment is crisp
  const trimmedPath = `${outWavPath}.trim.wav`;
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    rawWavPath,
    '-af',
    'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-acodec',
    'pcm_s16le',
    trimmedPath,
  ]);

  let currentDur = await probeAudioDuration(trimmedPath);
  if (currentDur <= 0.05) {
    currentDur = await probeAudioDuration(rawWavPath);
    fs.copyFileSync(rawWavPath, trimmedPath);
  }

  const safeTarget = Math.max(0.45, targetDurationSec);
  const rawTempo = currentDur / safeTarget;
  // Constrain speed adjustment strictly to preserve natural Urdu voice quality
  const clampedTempo = Math.min(1.36, Math.max(0.84, rawTempo));

  const filters: string[] = [];
  if (Math.abs(pitchSemitones) > 0.05) {
    const ratio = Math.pow(2, pitchSemitones / 12);
    const inv = 1 / ratio;
    filters.push(`asetrate=48000*${ratio.toFixed(5)},aresample=48000,atempo=${inv.toFixed(5)}`);
  }
  if (Math.abs(clampedTempo - 1.0) > 0.03) {
    filters.push(`atempo=${clampedTempo.toFixed(4)}`);
  }
  filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  await runProcess('ffmpeg', [
    '-y',
    '-i',
    trimmedPath,
    '-af',
    filters.join(','),
    '-ar',
    '48000',
    '-ac',
    '2',
    '-acodec',
    'pcm_s16le',
    outWavPath,
  ]);

  if (fs.existsSync(trimmedPath)) {
    fs.unlinkSync(trimmedPath);
  }
  return probeAudioDuration(outWavPath);
}

export async function renderMixedVoiceTrack(
  segments: DialogueSegment[],
  totalDurationSec: number,
  workDir: string,
  outVoiceWavPath: string
): Promise<void> {
  const activeSegments = segments.filter(
    (s) => s.timedWavPath && fs.existsSync(s.timedWavPath)
  );

  // Create silent stereo base track matching total movie duration
  if (activeSegments.length === 0) {
    await runProcess('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      totalDurationSec.toFixed(3),
      '-acodec',
      'pcm_s16le',
      outVoiceWavPath,
    ]);
    return;
  }

  // Mix in hierarchical batches of 14 segments so even 3-hour movies with 2,000+ lines never overflow CLI args
  const batchSize = 14;
  const batchOutputs: string[] = [];

  for (let i = 0; i < activeSegments.length; i += batchSize) {
    const batch = activeSegments.slice(i, i + batchSize);
    const batchWav = path.join(workDir, `voice_batch_${i}.wav`);
    const args: string[] = [
      '-y',
      '-f',
      'lavfi',
      '-t',
      totalDurationSec.toFixed(3),
      '-i',
      'anullsrc=r=48000:cl=stereo',
    ];
    const filterParts: string[] = [];
    const mixInputs: string[] = ['[0:a]'];

    batch.forEach((seg, idx) => {
      args.push('-i', seg.timedWavPath!);
      const inputIdx = idx + 1;
      const delayMs = Math.max(0, Math.round(seg.startSec * 1000));
      filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[d${inputIdx}]`);
      mixInputs.push(`[d${inputIdx}]`);
    });

    filterParts.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[out]`
    );

    await runProcess('ffmpeg', [
      ...args,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[out]',
      '-t',
      totalDurationSec.toFixed(3),
      '-acodec',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      batchWav,
    ]);

    batchOutputs.push(batchWav);
  }

  // Combine batch tracks (iteratively if > 14 batches)
  let currentLevel = batchOutputs;
  let round = 0;
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += batchSize) {
      const group = currentLevel.slice(i, i + batchSize);
      if (group.length === 1) {
        nextLevel.push(group[0]);
        continue;
      }
      const mergedPath = path.join(workDir, `voice_merge_r${round}_${i}.wav`);
      const args: string[] = ['-y'];
      group.forEach((file) => args.push('-i', file));
      const inputs = group.map((_, idx) => `[${idx}:a]`).join('');
      await runProcess('ffmpeg', [
        ...args,
        '-filter_complex',
        `${inputs}amix=inputs=${group.length}:duration=first:normalize=0[out]`,
        '-map',
        '[out]',
        '-acodec',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        mergedPath,
      ]);
      nextLevel.push(mergedPath);
    }
    currentLevel = nextLevel;
    round += 1;
  }

  fs.copyFileSync(currentLevel[0], outVoiceWavPath);
}

export async function mixVoiceAndBackground(
  bgBedWavPath: string,
  voiceTrackWavPath: string,
  outMasterAudioWavPath: string
): Promise<void> {
  // Sidechain compression ducks background music & SFX cleanly while Urdu characters speak
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    bgBedWavPath,
    '-i',
    voiceTrackWavPath,
    '-filter_complex',
    '[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.85[bg];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1.15,asplit=2[vo1][vo2];[bg][vo1]sidechaincompress=threshold=0.015:ratio=5:attack=35:release=260[bgduck];[bgduck][vo2]amix=inputs=2:duration=first:normalize=0[out]',
    '-map',
    '[out]',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    outMasterAudioWavPath,
  ]);
}

export async function muxFinalMp4(
  sourceVideoPath: string,
  masterAudioWavPath: string,
  outMp4Path: string
): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    sourceVideoPath,
    '-i',
    masterAudioWavPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-shortest',
    outMp4Path,
  ]);
}

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    seconds
  ).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function generateSrtSubtitles(segments: DialogueSegment[], outSrtPath: string): void {
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const lines = sorted.map((seg, idx) => {
    const start = formatSrtTimestamp(seg.startSec);
    const end = formatSrtTimestamp(Math.max(seg.startSec + 0.5, seg.endSec));
    const text = seg.urduText || seg.turkishText;
    return `${idx + 1}\n${start} --> ${end}\n[${seg.speakerLabel}] ${text}\n`;
  });
  fs.writeFileSync(outSrtPath, '\uFEFF' + lines.join('\n'), 'utf8');
}

export async function renderSyntheticVideoFromWav(
  audioWavPath: string,
  outMp4Path: string,
  titleText = 'Turkish Dialogue Test Clip'
): Promise<void> {
  const dur = Math.max(4, await probeAudioDuration(audioWavPath));
  const safeTitle = titleText.replace(/[:'\\]/g, ' ');
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=#0b1026:s=1280x720:r=24:d=${dur.toFixed(2)}`,
    '-i',
    audioWavPath,
    '-vf',
    `drawbox=x=80:y=80:w=1120:h=560:color=#7c3aed@0.25:t=2,drawtext=text='${safeTitle}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2-24,drawtext=text='Turkish Audio Sample  %{pts\\:hms}':fontcolor=#a78bfa:fontsize=22:x=(w-text_w)/2:y=(h-text_h)/2+32`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    outMp4Path,
  ]);
}
