# UrduDub AI — Turkish to Pakistani Urdu Movie Dubbing Studio

Full-stack AI movie dubbing application built with React, TypeScript, Tailwind CSS, Express.js, FFmpeg/FFprobe, Google Gemini AI (`@google/genai`), and Firebase Firestore/Authentication support.

## Core Capabilities

- **Long-Form Movie Support (Up to 180 Minutes)**:
  - Binary 8 MB resumable chunked uploads (`POST /api/movies/upload/init`, `PUT /api/movies/upload/chunk/:uploadId`, `POST /api/movies/upload/complete/:uploadId`) so multi-gigabyte films stream directly to disk without browser RAM buffering.
  - Overlapping 120-second audio segmentation (`4s` overlap) with persistent job status, per-chunk retry recovery (up to 3 automatic retries + manual resume), and real ETA computed strictly from completed chunks.
- **Speaker Diarization & Locked Character Voices**:
  - Cross-chunk speaker roster preserves character identities (`Speaker 1`, `Speaker 2`, etc.) and gender confidence across the entire movie.
  - Manual Character Voice Management UI allows overriding gender, renaming characters, previewing real Pakistani Urdu TTS audio, and locking distinct voices (`Tariq`, `Bilal`, `Zain`, `Kamran`, `Ayesha`, `Sana`, `Nadia`) per character.
- **Pakistani Urdu Translation & Timing Sync**:
  - Translates Turkish dialogue into natural Pakistani Urdu (`ur-PK`) preserving names, honorifics, and emotion.
  - FFmpeg trims silence and fits generated Urdu WAV speech cleanly inside original dialogue windows (`atempo` clamped `0.84x–1.36x`).
- **Background Score & SFX Preservation**:
  - Mid-side vocal attenuation + FFmpeg `sidechaincompress` ducks background music/SFX during Urdu speech and restores ambience between lines. Modular `SOURCE_SEPARATION_URL` hook supports external Demucs/Spleeter stem separation services.
- **MP4 & Urdu SRT Export**:
  - Muxes mastered AAC 192 kbps audio with original video stream (`-c:v copy -movflags +faststart`) and exports synchronized UTF-8 Urdu `.srt` subtitles via authenticated HTTP Range download URLs.

## Prerequisites

- Node.js `>= 22.0.0`
- `ffmpeg` and `ffprobe` available in `PATH`
- Server-side `GEMINI_API_KEY` (configured via environment / Secrets panel)

## Installation & Running

```bash
npm install
cp .env.example .env
# Set GEMINI_API_KEY in .env
npm run dev
```

Production build & start:

```bash
npm run build
NODE_ENV=production npm start
```

## Environment Variables

See `.env.example` for all configurable options:
- `GEMINI_API_KEY`: Required for live Turkish ASR (`gemini-3.5-transcribe`), speaker/Urdu translation (`gemini-4-hydrogen`), and Pakistani Urdu TTS (`gemini-3.8-flash-lite-tts` / `gemini-3.8-flash-tts`).
- `MAX_UPLOAD_GB`: Configurable storage upload cap (default `10`).
- `MAX_DURATION_MINUTES`: Maximum movie length (default `180`).
- `CHUNK_DURATION_SECONDS`: Audio chunk duration for long movies (default `120`).
- `SOURCE_SEPARATION_URL`: Optional external Demucs/Spleeter separation endpoint.

## Firebase Firestore & Auth

`firebase-blueprint.json` and hardened Eight-Pillar `firestore.rules` are included for Cloud Firestore & Firebase Google Authentication. When `firebase-applet-config.json` (or `VITE_FIREBASE_*` env vars) is present, the client uses Firebase Authentication (`signInWithPopup`) and verifies RS256 ID tokens on the backend; otherwise, it falls back seamlessly to HMAC-signed Local Studio Sessions backed by persistent disk storage (`data/studio-db.json`).
