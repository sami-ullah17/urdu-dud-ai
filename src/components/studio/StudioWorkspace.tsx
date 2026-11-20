import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Download,
  Film,
  LayoutDashboard,
  LogOut,
  Menu,
  Mic2,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  deleteMovieProject,
  fetchMovieDetail,
  fetchMovies,
  fetchProviderHealth,
  fetchUrduVoices,
} from '../../lib/api';
import {
  deleteMovieFromFirestore,
  subscribeUserMovies,
  syncMovieToFirestore,
} from '../../lib/firestoreSync';
import type {
  DashboardStats,
  MovieProject,
  ProviderHealth,
  StudioUserSession,
  UrduVoiceProfile,
} from '../../types/studio';
import { CharactersView } from './CharactersView';
import { DownloadView } from './DownloadView';
import { ProcessingView } from './ProcessingView';
import { UploadMovieView } from './UploadMovieView';

export type StudioTab = 'dashboard' | 'upload' | 'characters' | 'processing' | 'downloads';

interface StudioWorkspaceProps {
  user: StudioUserSession;
  initialTab: StudioTab;
  onBackToHome: () => void;
  onSignOut: () => void;
}

export function StudioWorkspace({
  user,
  initialTab,
  onBackToHome,
  onSignOut,
}: StudioWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>(initialTab);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [movies, setMovies] = useState<MovieProject[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    total: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  });
  const [selectedMovieId, setSelectedMovieId] = useState<string | null>(null);
  const [selectedMovieDetail, setSelectedMovieDetail] = useState<MovieProject | null>(null);
  const [voices, setVoices] = useState<UrduVoiceProfile[]>([]);
  const [health, setHealth] = useState<ProviderHealth | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'processing' | 'completed' | 'failed'>(
    'all'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const [moviesData, healthData, voicesData] = await Promise.all([
        fetchMovies(),
        fetchProviderHealth(),
        fetchUrduVoices(),
      ]);
      setMovies(moviesData.movies);
      setStats(moviesData.stats);
      setHealth(healthData);
      setVoices(voicesData);
      setSelectedMovieId((curr) => curr ?? moviesData.movies[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  // Attach owner-scoped Firestore listener when Firebase is active
  useEffect(() => {
    const unsub = subscribeUserMovies(user.uid, () => {
      // Keeps local Firestore listener synchronized for owner projects
    });
    return () => {
      if (unsub) unsub();
    };
  }, [user.uid]);

  // Load full detail (segments, logs, characters) for selected movie
  useEffect(() => {
    if (!selectedMovieId) {
      setSelectedMovieDetail(null);
      return;
    }
    let cancelled = false;
    void fetchMovieDetail(selectedMovieId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedMovieDetail(detail);
          void syncMovieToFirestore(detail).catch(() => {});
        }
      })
      .catch(() => {
        // Handled cleanly in workspace state
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMovieId]);

  // Poll active jobs automatically every 2.5s while any project is scanning/queued/processing
  const hasActiveJob = useMemo(
    () =>
      movies.some(
        (m) => m.status === 'processing' || m.status === 'queued' || m.status === 'scanning'
      ) ||
      selectedMovieDetail?.status === 'processing' ||
      selectedMovieDetail?.status === 'queued' ||
      selectedMovieDetail?.status === 'scanning',
    [movies, selectedMovieDetail?.status]
  );

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = setInterval(async () => {
      try {
        const listRes = await fetchMovies();
        setMovies(listRes.movies);
        setStats(listRes.stats);
        if (selectedMovieId) {
          const detail = await fetchMovieDetail(selectedMovieId);
          setSelectedMovieDetail(detail);
          void syncMovieToFirestore(detail).catch(() => {});
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [hasActiveJob, selectedMovieId]);

  const filteredMovies = useMemo(() => {
    return movies.filter((m) => {
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'processing'
            ? m.status === 'processing' || m.status === 'queued' || m.status === 'scanning'
            : m.status === statusFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesQuery =
        !q ||
        m.title.toLowerCase().includes(q) ||
        m.originalFilename.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [movies, statusFilter, searchQuery]);

  function handleSelectMovie(movie: MovieProject, nextTab?: StudioTab) {
    setSelectedMovieId(movie.id);
    setSelectedMovieDetail(movie);
    if (nextTab) setActiveTab(nextTab);
  }

  function handleMovieUpdated(updated: MovieProject) {
    setSelectedMovieId(updated.id);
    setSelectedMovieDetail(updated);
    void syncMovieToFirestore(updated).catch(() => {});
    void loadWorkspace();
  }

  function handleMovieDeleted(deletedId: string) {
    setMovies((prev) => prev.filter((m) => m.id !== deletedId));
    if (selectedMovieId === deletedId) {
      setSelectedMovieId(null);
      setSelectedMovieDetail(null);
    }
    setActiveTab('dashboard');
    void loadWorkspace();
  }

  async function confirmRowDelete() {
    if (!pendingDeleteId) return;
    try {
      await deleteMovieProject(pendingDeleteId);
      await deleteMovieFromFirestore(pendingDeleteId).catch(() => {});
      handleMovieDeleted(pendingDeleteId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setPendingDeleteId(null);
    }
  }

  const navItems: Array<{ id: StudioTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'upload', label: 'Upload Movie', icon: UploadCloud },
    { id: 'characters', label: 'Character Voices', icon: Mic2 },
    { id: 'processing', label: 'Processing Pipeline', icon: Activity },
    { id: 'downloads', label: 'Download & Export', icon: Download },
  ];

  const activeTabTitle = navItems.find((n) => n.id === activeTab)?.label ?? 'Dashboard';

  return (
    <div className="min-h-screen bg-[#080B18] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col justify-between border-r border-white/10 bg-[#0B0F22]">
        <div className="p-5 space-y-8">
          <button
            type="button"
            onClick={onBackToHome}
            className="text-left text-lg font-bold tracking-tight text-white whitespace-nowrap cursor-pointer"
          >
            UrduDub AI
          </button>

          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    isActive
                      ? 'bg-violet-600/20 text-white border border-violet-500/30'
                      : 'text-slate-400 hover:text-white hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0 text-violet-400" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-5 border-t border-white/10 space-y-3">
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-white truncate">{user.displayName}</p>
            <p className="text-xs text-slate-400 truncate">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-[#080B18] hover:bg-white/5 text-xs text-slate-300 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] bg-[#0B0F22] border-r border-white/10 flex flex-col justify-between p-5">
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={onBackToHome}
                  className="text-lg font-bold text-white"
                >
                  UrduDub AI
                </button>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close navigation"
                  className="p-1.5 text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium ${
                        isActive
                          ? 'bg-violet-600/20 text-white border border-violet-500/30'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Icon className="w-4 h-4 text-violet-400" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-[#080B18] text-xs text-slate-300"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 h-16 border-b border-white/10 bg-[#080B18]/90 backdrop-blur-md px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open studio navigation"
              className="lg:hidden p-2 rounded-lg text-slate-300 hover:bg-white/5"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-400 truncate">
              <span>Studio</span>
              <span className="mx-2 text-slate-600">/</span>
              <span className="text-white font-medium">{activeTabTitle}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {movies.length > 0 && (
              <select
                value={selectedMovieId ?? ''}
                onChange={(e) => setSelectedMovieId(e.target.value || null)}
                aria-label="Active movie project"
                className="hidden sm:block max-w-[220px] truncate px-3 py-1.5 rounded-lg bg-[#0F1429] border border-white/10 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
              >
                {movies.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setActiveTab('upload')}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-medium transition-all whitespace-nowrap cursor-pointer"
            >
              Upload Movie
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-[1200px] w-full mx-auto px-6 py-8">
          {error && (
            <div className="mb-6 p-4 rounded-xl bg-rose-950/50 border border-rose-500/30 flex items-start gap-3 text-sm text-rose-200">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'dashboard' && (
            <div className="space-y-8">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold text-white tracking-tight">
                  Studio Dashboard
                </h1>
                <p className="text-sm text-slate-300">
                  Manage uploaded Turkish films, active dubbing jobs, character voice locks, and
                  MP4 exports.
                </p>
              </div>

              {/* 4-Metric Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-1">
                  <span className="text-xs text-slate-400">Total Uploaded Movies</span>
                  <p className="text-3xl font-semibold text-white font-mono tabular-nums">
                    {stats.total}
                  </p>
                </div>
                <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-1">
                  <span className="text-xs text-slate-400">Processing Movies</span>
                  <p className="text-3xl font-semibold text-violet-300 font-mono tabular-nums">
                    {stats.processing}
                  </p>
                </div>
                <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-1">
                  <span className="text-xs text-slate-400">Completed Movies</span>
                  <p className="text-3xl font-semibold text-emerald-300 font-mono tabular-nums">
                    {stats.completed}
                  </p>
                </div>
                <div className="rounded-xl bg-[#0F1429] border border-white/10 p-5 space-y-1">
                  <span className="text-xs text-slate-400">Failed Jobs</span>
                  <p className="text-3xl font-semibold text-rose-300 font-mono tabular-nums">
                    {stats.failed}
                  </p>
                </div>
              </div>

              {/* Provider & Media Engine Readiness */}
              {health && (
                <div className="rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-white">
                      Pipeline Provider Configuration
                    </h2>
                    <span className="text-xs text-slate-400 tabular-nums">
                      Max {health.limits.maxDurationMinutes} min · {health.limits.maxUploadGb} GB
                      cap
                    </span>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                    <div className="space-y-1">
                      <span className="text-slate-400">Speech Recognition &amp; Translation</span>
                      <p className="text-slate-200 flex items-center gap-1.5">
                        <CheckCircle2
                          className={`w-3.5 h-3.5 shrink-0 ${
                            health.geminiConfigured ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        />
                        <span className="truncate">{health.asrProvider}</span>
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-slate-400">Urdu Voice Generation</span>
                      <p className="text-slate-200 truncate">{health.ttsProvider}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-slate-400">Media Engine (FFmpeg)</span>
                      <p className="text-slate-200">
                        {health.ffmpegAvailable && health.ffprobeAvailable
                          ? 'FFmpeg & FFprobe Ready'
                          : 'FFmpeg Unavailable'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-slate-400">Cloud Database &amp; Auth</span>
                      <p className="text-slate-200 truncate">
                        {health.firebaseConfigured
                          ? 'Firebase Firestore & Auth Active'
                          : 'Local Studio Persistence'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent Projects Table */}
              <div className="rounded-xl bg-[#0F1429] border border-white/10 overflow-hidden">
                <div className="p-5 border-b border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-1 p-1 rounded-lg bg-[#080B18] border border-white/10 self-start">
                    {(['all', 'processing', 'completed', 'failed'] as const).map((filterKey) => (
                      <button
                        key={filterKey}
                        type="button"
                        onClick={() => setStatusFilter(filterKey)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors cursor-pointer ${
                          statusFilter === filterKey
                            ? 'bg-violet-600 text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {filterKey}
                      </button>
                    ))}
                  </div>

                  <div className="relative w-full sm:w-64">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter projects..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#080B18] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                </div>

                {loading ? (
                  <div className="p-8 space-y-3">
                    <div className="h-10 rounded bg-white/5 animate-pulse" />
                    <div className="h-10 rounded bg-white/5 animate-pulse" />
                  </div>
                ) : filteredMovies.length === 0 ? (
                  <div className="p-12 text-center space-y-3">
                    <Film className="w-8 h-8 text-slate-500 mx-auto" />
                    <h3 className="text-base font-medium text-white">No Movie Projects Found</h3>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto">
                      Upload a Turkish MP4, MOV, or MKV movie—or synthesize a 12-second Turkish test
                      clip—to start dubbing into Pakistani Urdu.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('upload')}
                      className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-xs font-medium cursor-pointer"
                    >
                      Upload First Movie
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-white/10 text-xs text-slate-400">
                        <tr>
                          <th className="py-3 px-5 font-medium">Project</th>
                          <th className="py-3 px-4 font-medium">Duration</th>
                          <th className="py-3 px-4 font-medium">Status &amp; Stage</th>
                          <th className="py-3 px-4 font-medium text-right">Progress</th>
                          <th className="py-3 px-5 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {filteredMovies.map((movie) => (
                          <tr
                            key={movie.id}
                            className="hover:bg-white/[0.02] transition-colors"
                          >
                            <td className="py-3.5 px-5">
                              <p className="font-medium text-white truncate max-w-[260px]">
                                {movie.title}
                              </p>
                              <p className="text-xs text-slate-400 truncate max-w-[260px]">
                                {movie.originalFilename} ·{' '}
                                {(movie.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                              </p>
                            </td>
                            <td className="py-3.5 px-4 font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                              {(movie.durationSeconds / 60).toFixed(2)} min
                            </td>
                            <td className="py-3.5 px-4 text-xs">
                              <span
                                className={`font-medium capitalize ${
                                  movie.status === 'completed'
                                    ? 'text-emerald-300'
                                    : movie.status === 'failed'
                                      ? 'text-rose-300'
                                      : movie.status === 'processing' ||
                                          movie.status === 'scanning' ||
                                          movie.status === 'queued'
                                        ? 'text-violet-300'
                                        : 'text-slate-300'
                                }`}
                              >
                                {movie.status.replace(/_/g, ' ')}
                              </span>
                              <span className="block text-slate-400 truncate max-w-[180px]">
                                {movie.currentStage}
                              </span>
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono text-xs text-slate-200 tabular-nums">
                              {movie.progressPercent}%
                            </td>
                            <td className="py-3.5 px-5 text-right">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleSelectMovie(movie, 'characters')}
                                  className="px-2.5 py-1.5 rounded-md border border-white/10 hover:bg-white/5 text-xs text-slate-200 cursor-pointer whitespace-nowrap"
                                >
                                  Voices
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSelectMovie(movie, 'processing')}
                                  className="px-2.5 py-1.5 rounded-md border border-white/10 hover:bg-white/5 text-xs text-slate-200 cursor-pointer whitespace-nowrap"
                                >
                                  Pipeline
                                </button>
                                {movie.status === 'completed' && (
                                  <button
                                    type="button"
                                    onClick={() => handleSelectMovie(movie, 'downloads')}
                                    className="px-2.5 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-xs text-white cursor-pointer whitespace-nowrap"
                                  >
                                    Download
                                  </button>
                                )}
                                <button
                                  type="button"
                                  aria-label={`Delete ${movie.title}`}
                                  onClick={() => setPendingDeleteId(movie.id)}
                                  className="p-1.5 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-950/30 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'upload' && (
            <UploadMovieView
              health={health}
              onMovieCreated={(movie, nextTab) => {
                handleMovieUpdated(movie);
                setActiveTab(nextTab);
              }}
            />
          )}

          {activeTab === 'characters' && (
            <CharactersView
              movie={selectedMovieDetail}
              voices={voices}
              onMovieUpdated={handleMovieUpdated}
              onStartProcessing={() => setActiveTab('processing')}
            />
          )}

          {activeTab === 'processing' && (
            <ProcessingView
              movie={selectedMovieDetail}
              health={health}
              onMovieUpdated={handleMovieUpdated}
              onGoToCharacters={() => setActiveTab('characters')}
              onGoToDownload={() => setActiveTab('downloads')}
            />
          )}

          {activeTab === 'downloads' && (
            <DownloadView
              movie={selectedMovieDetail}
              onDeleted={handleMovieDeleted}
              onGoToProcessing={() => setActiveTab('processing')}
            />
          )}
        </main>
      </div>

      {pendingDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#050814]/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-xl bg-[#0F1429] border border-white/10 p-6 space-y-4">
            <h3 className="text-base font-semibold text-white">Delete Project?</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              This removes the source video, dubbed MP4, and Urdu SRT subtitles permanently.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingDeleteId(null)}
                className="px-3.5 py-1.5 rounded-lg border border-white/15 text-xs text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRowDelete}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs text-white cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
