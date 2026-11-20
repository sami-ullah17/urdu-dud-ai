export function HeroConsoleArtwork() {
  const waveformBars = [
    22, 38, 64, 48, 82, 95, 58, 40, 74, 88, 52, 30, 68, 92, 76, 44, 62, 85, 48, 28, 70, 90, 60, 36,
    50, 78, 42, 66, 84, 54, 34, 46,
  ];

  return (
    <div className="relative w-full h-full min-h-[340px] rounded-xl border border-white/10 bg-gradient-to-br from-[#0F1429] via-[#121735] to-[#1A1336] overflow-hidden flex flex-col justify-between p-6">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_75%_20%,rgba(124,58,237,0.22),transparent_55%)]" />

      {/* Top cinema monitor bar */}
      <div className="relative flex items-center justify-between border-b border-white/10 pb-4">
        <div className="text-xs text-slate-400 tabular-nums">
          <span>Timeline Preview</span>
          <span className="mx-2 text-slate-600">·</span>
          <span className="font-mono text-slate-300">02:44:18 / 03:00:00</span>
        </div>
        <span className="text-xs font-mono text-violet-300">tr-TR → ur-PK</span>
      </div>

      {/* Multi-speaker dialogue & waveform lanes */}
      <div className="relative my-6 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Speaker 1 · Tariq (Male A)</span>
            <span className="font-urdu text-sm text-slate-200">ہمیں فجر سے پہلے قلعے تک پہنچنا ہوگا۔</span>
          </div>
          <div className="flex items-end gap-1 h-12 px-2 py-2 rounded-lg bg-[#080B18]/70 border border-white/10">
            {waveformBars.map((h, i) => (
              <div
                key={`m-${i}`}
                style={{ height: `${Math.max(18, h)}%` }}
                className="flex-1 rounded-sm bg-gradient-to-t from-violet-600 to-indigo-400 opacity-85"
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Speaker 2 · Ayesha (Female A)</span>
            <span className="font-urdu text-sm text-slate-200">فکر مت کرو، میں نے تمام انتظامات کر لیے ہیں۔</span>
          </div>
          <div className="flex items-end gap-1 h-10 px-2 py-2 rounded-lg bg-[#080B18]/70 border border-white/10">
            {waveformBars.map((h, i) => (
              <div
                key={`f-${i}`}
                style={{ height: `${Math.max(16, (h * 7) % 92)}%` }}
                className="flex-1 rounded-sm bg-gradient-to-t from-indigo-500 to-purple-300 opacity-75"
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Preserved Score &amp; Ambient SFX Bed</span>
            <span className="font-mono text-slate-400">48 kHz Stereo · Ducking -11 dB</span>
          </div>
          <div className="h-3 rounded bg-[#080B18]/80 border border-white/10 overflow-hidden flex items-center px-1 gap-0.5">
            {Array.from({ length: 40 }).map((_, idx) => (
              <span
                key={`bed-${idx}`}
                className="flex-1 h-1.5 rounded-full bg-slate-500/50"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom mastering summary */}
      <div className="relative pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <span>Chunked Pipeline · 120s Segments · 4s Context Overlap</span>
        <span className="font-mono text-slate-300">MP4 + UTF-8 SRT</span>
      </div>
    </div>
  );
}

export function AcousticBoothArtwork() {
  return (
    <div className="w-full h-44 rounded-lg border border-white/10 bg-gradient-to-br from-[#0B1024] to-[#1A1238] p-5 flex items-center justify-center overflow-hidden relative">
      <svg
        viewBox="0 0 280 120"
        className="w-full h-full max-w-[260px]"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="voiceGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#6366F1" />
          </linearGradient>
        </defs>
        <rect x="20" y="18" width="96" height="84" rx="8" fill="#080B18" stroke="rgba(255,255,255,0.12)" />
        <circle cx="68" cy="48" r="14" fill="none" stroke="url(#voiceGrad)" strokeWidth="2.5" />
        <path d="M44 82 C44 68, 92 68, 92 82" fill="none" stroke="url(#voiceGrad)" strokeWidth="2.5" strokeLinecap="round" />

        <rect x="164" y="18" width="96" height="84" rx="8" fill="#080B18" stroke="rgba(255,255,255,0.12)" />
        <circle cx="212" cy="48" r="14" fill="none" stroke="#A78BFA" strokeWidth="2.5" />
        <path d="M188 82 C188 68, 236 68, 236 82" fill="none" stroke="#A78BFA" strokeWidth="2.5" strokeLinecap="round" />

        <path d="M122 60 L158 60" stroke="rgba(167,139,250,0.45)" strokeWidth="2" strokeDasharray="4 4" />
      </svg>
    </div>
  );
}
