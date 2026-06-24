// src/lib/auth-context.tsx
// Firebase Auth popup sign-in with Google.
// Provides both a Firebase Auth session (for Firestore) and a Google OAuth
// access token (for BigQuery / Vertex AI REST calls).

'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';
import { setAccessToken as storeToken, getAccessToken } from './gis-auth';

export interface GoogleUser {
  uid: string;
  name: string;
  email: string;
  picture: string;
}

export interface AuthState {
  user: GoogleUser | null;
  accessToken: string | null;
  projects: string[];
  activeProject: string;
  isLoading: boolean;
  bqAuthorized: boolean;
  bqRefreshToken: string | null;
  signIn: () => void;
  signOut: () => void;
  setActiveProject: (p: string) => void;
  setBqTokenState: (refreshToken: string) => void;
  error: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

// Add BQ + Cloud Platform scopes to the Google provider
const scopedProvider = new GoogleAuthProvider();
scopedProvider.addScope('https://www.googleapis.com/auth/bigquery');
scopedProvider.addScope('https://www.googleapis.com/auth/cloud-platform');
scopedProvider.setCustomParameters({
  prompt: 'consent',
  include_granted_scopes: 'true',
});

function toGoogleUser(fbUser: User): GoogleUser {
  return {
    uid: fbUser.uid,
    name: fbUser.displayName || '',
    email: fbUser.email || '',
    picture: fbUser.photoURL || '',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [activeProject, setActiveProjectState] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sync token to both React state and the module-level store
  const setAccessToken = useCallback((token: string | null) => {
    storeToken(token);
    setAccessTokenState(token);
  }, []);

  // Listen for Firebase Auth state changes
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        setUser(toGoogleUser(fbUser));
      } else {
        setUser(null);
        setAccessToken(null);
      }
      setIsLoading(false);
    });
    return unsub;
  }, [setAccessToken]);

  // Load active project from localStorage
  useEffect(() => {
    if (!user) return;
    const saved = localStorage.getItem('bqaif_activeProject');
    if (saved) setActiveProjectState(saved);
  }, [user]);

  const signIn = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await signInWithPopup(auth, scopedProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      // Try multiple ways to extract the Google OAuth access token
      const oauthToken = credential?.accessToken
        || (result as any)._tokenResponse?.oauthAccessToken
        || (result as any)._tokenResponse?.access_token;
      if (oauthToken) {
        setAccessToken(oauthToken);
        setError(null);
      } else {
        // Show debug info so we can figure out what Firebase returned
        const keys = credential ? Object.keys(credential) : [];
        const trKeys = (result as any)._tokenResponse ? Object.keys((result as any)._tokenResponse) : [];
        setError(`No access token found. credential keys: [${keys.join(',')}], _tokenResponse keys: [${trKeys.join(',')}]`);
      }
      if (result.user) {
        setUser(toGoogleUser(result.user));
      }
    } catch (err: any) {
      console.error('[auth] Sign-in failed:', err.code, err.message);
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        // User closed the popup -- not an error
      } else {
        setError(`${err.code || 'unknown'}: ${err.message || 'Sign-in failed'}`);
      }
    } finally {
      setIsLoading(false);
    }
  }, [setAccessToken]);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
    setAccessToken(null);
    setUser(null);
    setError(null);
  }, [setAccessToken]);

  const setActiveProject = useCallback((p: string) => {
    setActiveProjectState(p);
    localStorage.setItem('bqaif_activeProject', p);
  }, []);

  const setBqTokenState = useCallback((_refreshToken: string) => {
    // No-op
  }, []);

  const bqAuthorized = !!user && !!accessToken;

  return (
    <AuthContext.Provider value={{
      user,
      accessToken,
      projects: activeProject ? [activeProject] : [],
      activeProject,
      isLoading,
      bqAuthorized,
      bqRefreshToken: null,
      signIn,
      signOut,
      setActiveProject,
      setBqTokenState,
      error,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
