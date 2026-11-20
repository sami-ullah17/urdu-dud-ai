import { useState, type FormEvent } from 'react';
import { Lock, ArrowRight, Check, Copy, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { createStudioSession } from '../lib/api';
import {
  firebaseProjectId,
  isFirebaseConfigured,
  signInWithGooglePopup,
} from '../lib/firebase';
import type { StudioUserSession } from '../types/studio';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: (user: StudioUserSession) => void;
}

export function AuthModal({ open, onClose, onAuthenticated }: AuthModalProps) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorizedHost, setUnauthorizedHost] = useState<string | null>(null);
  const [copiedHost, setCopiedHost] = useState(false);

  if (!open) return null;

  async function handleCopyHost() {
    if (!unauthorizedHost || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(unauthorizedHost);
      setCopiedHost(true);
      setTimeout(() => setCopiedHost(false), 2000);
    } catch {
      // Clipboard API unavailable
    }
  }

  async function handleGoogleAuth() {
    setError(null);
    setUnauthorizedHost(null);
    setCopiedHost(false);
    setLoading(true);
    try {
      const cred = await signInWithGooglePopup();
      const idToken = await cred.user.getIdToken();
      localStorage.setItem('urdudub_studio_token', idToken);
      onAuthenticated({
        uid: cred.user.uid,
        email: cred.user.email ?? 'user@urdudub.ai',
        displayName: cred.user.displayName ?? 'Studio Producer',
        shortClipVerified: false,
        authMode: 'firebase',
      });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      const message = err instanceof Error ? err.message : 'Google sign-in failed.';
      if (code === 'auth/unauthorized-domain' || message.includes('auth/unauthorized-domain')) {
        const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
        setUnauthorizedHost(host);
        setError(
          `Domain "${host}" is not authorized in Firebase Authentication yet. Add "${host}" under Firebase Console -> Authentication -> Settings -> Authorized domains.`
        );
      } else if (code === 'auth/popup-blocked' || message.includes('auth/popup-blocked')) {
        setError(
          'Your browser blocked the Google sign-in popup. Please allow popups for this site and click Continue with Google again.'
        );
      } else if (code === 'auth/popup-closed-by-user') {
        setError('Google sign-in popup was closed before completion. Please try again.');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleStudioSessionSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !email.includes('@')) {
      setError('Enter a valid email address to open your studio workspace.');
      return;
    }
    setLoading(true);
    try {
      const user = await createStudioSession(
        email.trim(),
        displayName.trim() || email.trim().split('@')[0]
      );
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start studio session.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#050814]/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="w-full max-w-md rounded-xl bg-[#0F1429] border border-white/10 p-7 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="auth-modal-title" className="text-xl font-semibold text-white tracking-tight">
              Sign in to UrduDub AI
            </h2>
            <p className="text-sm text-slate-400">
              Access private movie uploads, speaker voice locks, and MP4 exports.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in dialog"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-500/30 text-sm text-rose-200 space-y-3">
            <p>{error}</p>
            {unauthorizedHost && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCopyHost}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-xs font-medium text-white transition-colors cursor-pointer"
                >
                  {copiedHost ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied {unauthorizedHost}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy {unauthorizedHost}
                    </>
                  )}
                </button>
                <a
                  href={`https://console.firebase.google.com/project/${firebaseProjectId}/authentication/settings`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-violet-600/30 hover:bg-violet-600/45 border border-violet-400/30 text-xs font-medium text-violet-200 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Firebase Authorized Domains
                </a>
              </div>
            )}
          </div>
        )}

        {isFirebaseConfigured ? (
          <div className="space-y-4">
            <button
              type="button"
              disabled={loading}
              onClick={handleGoogleAuth}
              className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Lock className="w-4 h-4" />
              {loading ? 'Signing in...' : 'Continue with Google'}
            </button>
            <p className="text-xs text-slate-400 text-center">
              Protected by Firebase Authentication and owner-only Firestore security rules.
            </p>
          </div>
        ) : (
          <form onSubmit={handleStudioSessionSubmit} className="space-y-4">
            <div className="p-3 rounded-lg bg-indigo-950/40 border border-indigo-500/20 text-xs text-slate-300 leading-relaxed flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
              <span>
                Firebase Cloud config is not provisioned in this workspace yet. Sign in with a
                persistent Local Studio Session (HMAC-signed token + private project isolation).
              </span>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="studio-name" className="block text-xs font-medium text-slate-300">
                Producer / Studio Name
              </label>
              <input
                id="studio-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Tariq Studios"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="studio-email" className="block text-xs font-medium text-slate-300">
                Email Address
              </label>
              <input
                id="studio-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="producer@studio.pk"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B18] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? 'Opening Workspace...' : 'Enter Studio Workspace'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
