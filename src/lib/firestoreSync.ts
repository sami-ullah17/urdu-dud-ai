import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  OperationType,
  firebaseAuth,
  firestoreDb,
  handleFirestoreError,
  isFirebaseConfigured,
} from './firebase';
import type { CharacterProfile, MovieProject, StudioUserSession } from '../types/studio';

const createdMovieIds = new Set<string>();
const completedMovieIds = new Set<string>();
const syncedLogIds = new Set<string>();

function isReadyForFirestore(): boolean {
  return Boolean(
    isFirebaseConfigured &&
      firestoreDb &&
      firebaseAuth?.currentUser &&
      firebaseAuth.currentUser.emailVerified !== false
  );
}

export async function syncUserProfileToFirestore(user: StudioUserSession): Promise<void> {
  if (!isReadyForFirestore() || !firestoreDb) return;
  const path = `users/${user.uid}`;
  const ref = doc(firestoreDb, 'users', user.uid);
  const safeEmail = (user.email && user.email.length >= 3 ? user.email : 'user@urdudub.ai').slice(
    0,
    254
  );
  const safeDisplayName = (user.displayName || 'Studio Producer').slice(0, 120);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email: safeEmail,
        displayName: safeDisplayName,
        shortClipVerified: Boolean(user.shortClipVerified),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName: safeDisplayName,
        shortClipVerified: Boolean(user.shortClipVerified),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserMovies(
  ownerId: string,
  onUpdate: (count: number) => void
): Unsubscribe | null {
  if (!isReadyForFirestore() || !firestoreDb) return null;
  const q = query(collection(firestoreDb, 'movies'), where('ownerId', '==', ownerId));
  return onSnapshot(
    q,
    (snapshot) => {
      for (const d of snapshot.docs) {
        createdMovieIds.add(d.id);
        if (d.data()?.status === 'completed') {
          completedMovieIds.add(d.id);
        }
      }
      onUpdate(snapshot.size);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'movies');
    }
  );
}

export async function syncMovieToFirestore(movie: MovieProject): Promise<void> {
  if (!isReadyForFirestore() || !firestoreDb || !firebaseAuth?.currentUser) return;
  const uid = firebaseAuth.currentUser.uid;
  if (movie.ownerId !== uid) return;

  const moviePath = `movies/${movie.id}`;
  const movieRef = doc(firestoreDb, 'movies', movie.id);

  try {
    if (!createdMovieIds.has(movie.id)) {
      const snap = await getDoc(movieRef);
      if (snap.exists()) {
        createdMovieIds.add(movie.id);
        if (snap.data()?.status === 'completed') {
          completedMovieIds.add(movie.id);
        }
      }
    }

    if (!createdMovieIds.has(movie.id)) {
      await setDoc(movieRef, {
        id: movie.id,
        ownerId: uid,
        title: (movie.title || 'Untitled Movie').slice(0, 180),
        originalFilename: (movie.originalFilename || 'movie.mp4').slice(0, 255),
        format: movie.format,
        fileSizeBytes: Math.max(1, movie.fileSizeBytes || 1),
        durationSeconds: Math.min(10800, Math.max(0.1, movie.durationSeconds || 1)),
        sourceLang: 'tr',
        targetLang: 'ur-PK',
        rightsConfirmed: true,
        status: movie.status,
        currentStage: movie.currentStage.slice(0, 120),
        stageIndex: Math.min(10, Math.max(0, movie.stageIndex)),
        progressPercent: Math.min(100, Math.max(0, movie.progressPercent)),
        totalChunks: Math.min(500, Math.max(0, movie.totalChunks)),
        completedChunks: Math.min(500, Math.max(0, movie.completedChunks)),
        failedChunks: Math.min(500, Math.max(0, movie.failedChunks)),
        totalTtsChunks: Math.min(20000, Math.max(0, movie.totalTtsChunks ?? 0)),
        completedTtsChunks: Math.min(20000, Math.max(0, movie.completedTtsChunks ?? 0)),
        remainingTtsChunks: Math.min(20000, Math.max(0, movie.remainingTtsChunks ?? 0)),
        pauseReason: (movie.pauseReason ?? '').slice(0, 64),
        demoMode: Boolean(movie.demoMode),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      createdMovieIds.add(movie.id);
      if (movie.status === 'completed') {
        completedMovieIds.add(movie.id);
      }
    } else if (!completedMovieIds.has(movie.id)) {
      await updateDoc(movieRef, {
        title: movie.title.slice(0, 180) || 'Untitled Movie',
        status: movie.status,
        currentStage: movie.currentStage.slice(0, 120),
        stageIndex: Math.min(10, Math.max(0, movie.stageIndex)),
        progressPercent: Math.min(100, Math.max(0, movie.progressPercent)),
        totalChunks: Math.min(500, Math.max(0, movie.totalChunks)),
        completedChunks: Math.min(500, Math.max(0, movie.completedChunks)),
        failedChunks: Math.min(500, Math.max(0, movie.failedChunks)),
        totalTtsChunks: Math.min(20000, Math.max(0, movie.totalTtsChunks ?? 0)),
        completedTtsChunks: Math.min(20000, Math.max(0, movie.completedTtsChunks ?? 0)),
        remainingTtsChunks: Math.min(20000, Math.max(0, movie.remainingTtsChunks ?? 0)),
        pauseReason: (movie.pauseReason ?? '').slice(0, 64),
        demoMode: Boolean(movie.demoMode),
        updatedAt: serverTimestamp(),
      });
      if (movie.status === 'completed') {
        completedMovieIds.add(movie.id);
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, moviePath);
  }

  // Sync character voice assignments
  for (const char of movie.characters) {
    await syncCharacterToFirestore(movie.id, uid, char);
  }

  // Sync latest logs (append-only)
  for (const log of movie.logs.slice(-20)) {
    if (syncedLogIds.has(log.id)) continue;
    const logPath = `movies/${movie.id}/logs/${log.id}`;
    const logRef = doc(firestoreDb, 'movies', movie.id, 'logs', log.id);
    try {
      const existingLog = await getDoc(logRef);
      if (!existingLog.exists()) {
        await setDoc(logRef, {
          id: log.id,
          movieId: movie.id,
          ownerId: uid,
          stage: log.stage.slice(0, 100),
          level: log.level,
          message: log.message.slice(0, 500) || 'Log entry',
          createdAt: serverTimestamp(),
        });
      }
      syncedLogIds.add(log.id);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, logPath);
    }
  }
}

async function syncCharacterToFirestore(
  movieId: string,
  uid: string,
  char: CharacterProfile
): Promise<void> {
  if (!firestoreDb) return;
  const charPath = `movies/${movieId}/characters/${char.id}`;
  const charRef = doc(firestoreDb, 'movies', movieId, 'characters', char.id);
  try {
    const snap = await getDoc(charRef);
    const payload = {
      id: char.id,
      movieId,
      ownerId: uid,
      speakerLabel: (char.speakerLabel || 'Speaker').slice(0, 64),
      characterName: (char.characterName || char.speakerLabel || 'Character').slice(0, 100),
      gender: char.gender,
      genderConfidence: Math.min(1, Math.max(0, char.genderConfidence)),
      voiceProfileId: (char.voiceProfileId || 'urdu_male_a').slice(0, 64),
      lineCount: Math.max(0, char.lineCount),
      sampleTurkish: (char.sampleTurkish ?? '').slice(0, 500),
      sampleUrdu: (char.sampleUrdu ?? '').slice(0, 500),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(charRef, payload);
    } else {
      await updateDoc(charRef, {
        characterName: payload.characterName,
        gender: payload.gender,
        genderConfidence: payload.genderConfidence,
        voiceProfileId: payload.voiceProfileId,
        lineCount: payload.lineCount,
        sampleTurkish: payload.sampleTurkish,
        sampleUrdu: payload.sampleUrdu,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, charPath);
  }
}

export async function deleteMovieFromFirestore(movieId: string): Promise<void> {
  if (!isReadyForFirestore() || !firestoreDb || !firebaseAuth?.currentUser) return;
  const uid = firebaseAuth.currentUser.uid;
  try {
    const charsSnap = await getDocs(
      query(
        collection(firestoreDb, 'movies', movieId, 'characters'),
        where('ownerId', '==', uid)
      )
    );
    for (const cDoc of charsSnap.docs) {
      await deleteDoc(cDoc.ref);
    }
    const logsSnap = await getDocs(
      query(
        collection(firestoreDb, 'movies', movieId, 'logs'),
        where('ownerId', '==', uid)
      )
    );
    for (const lDoc of logsSnap.docs) {
      await deleteDoc(lDoc.ref);
    }
    await deleteDoc(doc(firestoreDb, 'movies', movieId));
    createdMovieIds.delete(movieId);
    completedMovieIds.delete(movieId);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `movies/${movieId}`);
  }
}
