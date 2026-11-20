import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { AuthModal } from './components/AuthModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './components/HomePage';
import { StudioWorkspace, type StudioTab } from './components/studio/StudioWorkspace';
import { fetchCurrentUser, getStoredAuthToken, setStoredAuthToken } from './lib/api';
import { firebaseAuth, isFirebaseConfigured, signOutFirebase } from './lib/firebase';
import { syncUserProfileToFirestore } from './lib/firestoreSync';
import type { StudioUserSession } from './types/studio';

function AppShell() {
  const [user, setUser] = useState<StudioUserSession | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<'home' | 'studio'>('home');
  const [studioTab, setStudioTab] = useState<StudioTab>('dashboard');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingTabAfterAuth, setPendingTabAfterAuth] = useState<StudioTab>('dashboard');

  useEffect(() => {
    if (isFirebaseConfigured && firebaseAuth) {
      const unsub = onAuthStateChanged(firebaseAuth, async (fbUser) => {
        if (fbUser) {
          const idToken = await fbUser.getIdToken();
          setStoredAuthToken(idToken);
          const session: StudioUserSession = {
            uid: fbUser.uid,
            email: fbUser.email ?? 'user@urdudub.ai',
            displayName: fbUser.displayName ?? 'Studio Producer',
            shortClipVerified: false,
            authMode: 'firebase',
          };
          setUser(session);
          void syncUserProfileToFirestore(session).catch(() => {});
        } else {
          setStoredAuthToken(null);
          setUser(null);
        }
        setAuthReady(true);
      });
      return () => unsub();
    }

    const token = getStoredAuthToken();
    if (!token) {
      setAuthReady(true);
      return;
    }

    void fetchCurrentUser()
      .then((me) => {
        setUser(me);
      })
      .catch(() => {
        setStoredAuthToken(null);
        setUser(null);
      })
      .finally(() => {
        setAuthReady(true);
      });
  }, []);

  async function handleSignOut() {
    setStoredAuthToken(null);
    if (isFirebaseConfigured) {
      await signOutFirebase();
    }
    setUser(null);
    setView('home');
  }

  function handleOpenStudio(targetTab: StudioTab = 'dashboard') {
    if (!user) {
      setPendingTabAfterAuth(targetTab);
      setAuthModalOpen(true);
      return;
    }
    setStudioTab(targetTab);
    setView('studio');
  }

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#080B18] text-slate-300 flex items-center justify-center text-sm">
        Initializing UrduDub AI Studio...
      </div>
    );
  }

  return (
    <>
      {view === 'studio' && user ? (
        <StudioWorkspace
          user={user}
          initialTab={studioTab}
          onBackToHome={() => setView('home')}
          onSignOut={handleSignOut}
        />
      ) : (
        <HomePage
          isAuthenticated={Boolean(user)}
          onOpenStudio={(tab) => handleOpenStudio(tab ?? 'dashboard')}
          onRequestAuth={() => {
            setPendingTabAfterAuth('upload');
            setAuthModalOpen(true);
          }}
        />
      )}

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={(signedInUser) => {
          setUser(signedInUser);
          setAuthModalOpen(false);
          setStudioTab(pendingTabAfterAuth);
          setView('studio');
        }}
      />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
