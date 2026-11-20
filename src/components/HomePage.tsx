import { ArrowRight, Check, Film, Languages, Mic2, Shield, SlidersHorizontal, Volume2 } from 'lucide-react';
import { motion } from 'motion/react';
import { AcousticBoothArtwork, HeroConsoleArtwork } from './StudioArtwork';

interface HomePageProps {
  isAuthenticated: boolean;
  onOpenStudio: (targetTab?: 'dashboard' | 'upload') => void;
  onRequestAuth: () => void;
}

export function HomePage({ isAuthenticated, onOpenStudio, onRequestAuth }: HomePageProps) {
  function handlePrimaryUploadClick() {
    if (isAuthenticated) {
      onOpenStudio('upload');
    } else {
      onRequestAuth();
    }
  }

  function handleOpenStudioClick() {
    if (isAuthenticated) {
      onOpenStudio('dashboard');
    } else {
      onRequestAuth();
    }
  }

  const workflowSteps = [
    {
      num: '01.',
      title: 'Upload & Media Verification',
      body: 'Stream MP4, MOV, or MKV films up to 180 minutes in resumable binary chunks. Server-side FFprobe validates audio/video streams and duration before queuing.',
    },
    {
      num: '02.',
      title: 'Chunked Turkish ASR & Diarization',
      body: 'Audio is extracted and segmented into 120-second overlapping windows. Each dialogue turn receives exact timestamps, speaker IDs, and gender confidence.',
    },
    {
      num: '03.',
      title: 'Character Voice Locking & Translation',
      body: 'Turkish lines are translated into natural Pakistani Urdu preserving names and tone. Every character keeps one locked male or female Urdu voice across every scene.',
    },
    {
      num: '04.',
      title: 'Timing Sync, SFX Mix & MP4 Export',
      body: 'Urdu speech is time-fitted without clipping, blended over preserved music and ambient SFX via sidechain ducking, and muxed into an MP4 with Urdu SRT subtitles.',
    },
  ];

  const pricingTiers = [
    {
      name: 'Short Film & Pilot',
      audience: 'For creators verifying short clips',
      price: '$0',
      cadence: 'Display plan · Self-hosted / API metered',
      limits: [
        'Maximum duration: 15 minutes per upload',
        'Upload storage cap: 2 GB per file',
        'Speaker voice lock: Up to 4 characters',
        'Exports: MP4 video + UTF-8 Urdu SRT',
      ],
    },
    {
      name: 'Feature Cinema Studio',
      audience: 'For full-length Turkish feature dubbing',
      price: '$49',
      cadence: 'Per month · Display tier',
      highlighted: true,
      limits: [
        'Maximum duration: 180 minutes (3 hours)',
        'Upload storage cap: 10 GB resumable upload',
        'Speaker voice lock: Unlimited characters + manual overrides',
        'Exports: 192 kbps AAC MP4 + synchronized Urdu SRT',
      ],
    },
    {
      name: 'Broadcast Archive',
      audience: 'For serialized drama localization teams',
      price: '$149',
      cadence: 'Per month · Display tier',
      limits: [
        'Maximum duration: 180 minutes per episode',
        'Upload storage cap: 25 GB configurable bucket',
        'External Demucs / Spleeter stem separation hook',
        'Automatic chunk recovery & persistent job logs',
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-[#080B18] text-slate-100 flex flex-col">
      {/* Strictly conforms to Top Bar Contract: 1-line brand — 4 nav links — 1 primary CTA */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#080B18]/90 backdrop-blur-md">
        <div className="max-w-[1200px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            UrduDub AI
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            <a
              href="#how-it-works"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              How It Works
            </a>
            <a
              href="#features"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Features
            </a>
            <a
              href="#pricing"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Pricing
            </a>
            <button
              type="button"
              onClick={handleOpenStudioClick}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Studio
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={handlePrimaryUploadClick}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              Upload Movie
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-b border-white/10">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_top_left,rgba(124,58,237,0.16),transparent_55%)]" />
          <div className="max-w-[1200px] mx-auto px-6 py-16 lg:py-24 grid lg:grid-cols-12 gap-10 items-stretch">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
              className="lg:col-span-6 flex flex-col justify-center space-y-6"
            >
              <p className="text-xs font-medium tracking-wide text-violet-300">
                Turkish Cinema to Pakistani Urdu Localization
              </p>
              <h1
                className="font-semibold text-white tracking-tight leading-[1.08]"
                style={{ fontSize: 'clamp(2.25rem, 4vw, 3.5rem)', textWrap: 'balance' }}
              >
                Dub full-length Turkish films into natural Pakistani Urdu voices.
              </h1>
              <p className="text-base text-slate-300 leading-relaxed max-w-xl">
                Upload Turkish movies up to 180 minutes. UrduDub AI identifies recurring speakers,
                locks distinct male and female Pakistani Urdu voices per character, preserves
                background scores and sound effects, and exports a synchronized MP4.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <button
                  type="button"
                  onClick={handlePrimaryUploadClick}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all whitespace-nowrap cursor-pointer"
                >
                  Upload Movie
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleOpenStudioClick}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-lg border border-white/15 bg-[#0F1429] hover:bg-[#151B35] text-slate-200 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isAuthenticated ? 'Open Studio Dashboard' : 'Sign In to Studio'}
                </button>
              </div>

              <div className="pt-4 border-t border-white/10 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>MP4 · MOV · MKV</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">Up to 180 minutes</span>
                <span aria-hidden="true">·</span>
                <span>Authorized media only</span>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.08 }}
              className="lg:col-span-6 flex"
            >
              <HeroConsoleArtwork />
            </motion.div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="border-b border-white/10">
          <div className="max-w-[1200px] mx-auto px-6 py-20 space-y-12">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">
                How It Works
              </h2>
              <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                A deterministic ten-stage audio and video pipeline engineered for three-hour feature
                films without browser memory bottlenecks.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {workflowSteps.map((step) => (
                <div
                  key={step.num}
                  className="rounded-xl bg-[#0F1429] border border-white/10 p-6 flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-3">
                    <span className="block font-mono text-sm text-violet-400 tabular-nums">
                      {step.num}
                    </span>
                    <h3 className="text-lg font-semibold text-white">{step.title}</h3>
                    <p className="text-sm text-slate-300 leading-relaxed">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features Asymmetric Bento Grid */}
        <section id="features" className="border-b border-white/10">
          <div className="max-w-[1200px] mx-auto px-6 py-20 space-y-12">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">
                Built for Feature-Length Cinema Localization
              </h2>
              <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                Every stage preserves character identity, dialogue pacing, and original sound design.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              {/* Wide Feature Card */}
              <div className="md:col-span-2 rounded-xl bg-[#0F1429] border border-white/10 p-7 flex flex-col justify-between gap-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-2.5 text-violet-300 text-sm font-medium">
                    <Mic2 className="w-4 h-4" />
                    <span>Persistent Character Voice Locking</span>
                  </div>
                  <h3 className="text-xl font-semibold text-white">
                    One stable Pakistani Urdu voice per character from opening scene to credits.
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed max-w-2xl">
                    Diarization carries a running speaker roster across every 120-second audio
                    chunk. Assign Tariq, Bilal, or Zain to male roles and Ayesha, Sana, or Nadia to
                    female roles—or adjust any misidentified character manually before synthesis.
                  </p>
                </div>
                <AcousticBoothArtwork />
              </div>

              <div className="rounded-xl bg-[#0F1429] border border-white/10 p-7 space-y-4">
                <div className="flex items-center gap-2.5 text-violet-300 text-sm font-medium">
                  <Film className="w-4 h-4" />
                  <span>180-Minute Chunk Queue</span>
                </div>
                <h3 className="text-lg font-semibold text-white">
                  Resumable Uploads &amp; Chunk Retries
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Binary 8 MB chunked uploads stream straight to disk. Background workers track
                  every audio segment persistently, automatically retrying failed chunks up to three
                  times without restarting the film.
                </p>
                <div className="pt-3 border-t border-white/10 text-xs text-slate-400 space-y-1 font-mono tabular-nums">
                  <div>Max Duration: 180 min</div>
                  <div>Overlap Window: 4.0 sec</div>
                  <div>Chunk Retries: 3 attempts</div>
                </div>
              </div>

              <div className="rounded-xl bg-[#0F1429] border border-white/10 p-7 space-y-3">
                <div className="flex items-center gap-2.5 text-violet-300 text-sm font-medium">
                  <Volume2 className="w-4 h-4" />
                  <span>Score &amp; SFX Preservation</span>
                </div>
                <h3 className="text-lg font-semibold text-white">
                  Dialogue Suppression &amp; Sidechain Ducking
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Mid-side vocal attenuation reduces original Turkish speech while retaining music
                  and ambient stereo effects, with optional Demucs/Spleeter endpoint routing.
                </p>
              </div>

              <div className="rounded-xl bg-[#0F1429] border border-white/10 p-7 space-y-3">
                <div className="flex items-center gap-2.5 text-violet-300 text-sm font-medium">
                  <Languages className="w-4 h-4" />
                  <span>Pakistani Urdu Localization</span>
                </div>
                <h3 className="text-lg font-semibold text-white">
                  Natural Idiomatic Urdu &amp; SRT Subtitles
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Gemini preserves character names, honorifics, and gender agreement in authentic
                  Pakistani Urdu, exporting synchronized UTF-8 SRT subtitles alongside the MP4.
                </p>
              </div>

              <div className="rounded-xl bg-[#0F1429] border border-white/10 p-7 space-y-3">
                <div className="flex items-center gap-2.5 text-violet-300 text-sm font-medium">
                  <SlidersHorizontal className="w-4 h-4" />
                  <span>Timing Synchronization</span>
                </div>
                <h3 className="text-lg font-semibold text-white">
                  Quality-Safe Tempo Fitting
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  FFmpeg trims dead air and constrains tempo scaling to 0.84x–1.36x so Urdu lines
                  land cleanly inside original cue boundaries without robotic artifacts.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Section (Display only — no fake payment checkout) */}
        <section id="pricing" className="border-b border-white/10">
          <div className="max-w-[1200px] mx-auto px-6 py-20 space-y-12">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div className="max-w-2xl space-y-3">
                <h2 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">
                  Studio Capacity Tiers
                </h2>
                <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                  Reference capacity profiles for short-clip testing and full three-hour film
                  localization. Displayed for planning; no billing checkout is active in this
                  studio build.
                </p>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              {pricingTiers.map((tier) => (
                <div
                  key={tier.name}
                  className={`rounded-xl p-7 flex flex-col justify-between space-y-6 border ${
                    tier.highlighted
                      ? 'bg-gradient-to-b from-[#161B38] to-[#0F1429] border-violet-500/40'
                      : 'bg-[#0F1429] border-white/10'
                  }`}
                >
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{tier.name}</h3>
                      <p className="text-xs text-slate-400 mt-1">{tier.audience}</p>
                    </div>
                    <div className="pt-2 border-t border-white/10">
                      <span className="text-3xl font-semibold text-white tabular-nums">
                        {tier.price}
                      </span>
                      <p className="text-xs text-slate-400 mt-1">{tier.cadence}</p>
                    </div>
                    <ul className="space-y-2.5 pt-2">
                      {tier.limits.map((lim) => (
                        <li key={lim} className="flex items-start gap-2.5 text-sm text-slate-300">
                          <Check className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
                          <span>{lim}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <button
                    type="button"
                    onClick={handlePrimaryUploadClick}
                    className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      tier.highlighted
                        ? 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white'
                        : 'bg-[#080B18] border border-white/15 hover:bg-white/5 text-slate-200'
                    }`}
                  >
                    Open Studio
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#080B18] py-10">
        <div className="max-w-[1200px] mx-auto px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-violet-400 shrink-0" />
            <span>
              UrduDub AI · Only process videos you own or hold explicit permission to dub.
            </span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#how-it-works" className="hover:text-slate-200 transition-colors">
              Workflow
            </a>
            <a href="#features" className="hover:text-slate-200 transition-colors">
              Architecture
            </a>
            <a href="#pricing" className="hover:text-slate-200 transition-colors">
              Capacity
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
