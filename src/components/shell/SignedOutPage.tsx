'use client';

import { useAuth } from '@/lib/auth-context';
import { AnimatedCrystalBall } from '@/components/AnimatedCrystalBall';

export function SignedOutPage() {
  const { signIn, isLoading, error } = useAuth();

  return (
    <div className="so-shell">
      {/* Full-page background with glow orbs */}
      <div className="so-grid" aria-hidden="true" />
      <div className="so-glow so-glow-blue" aria-hidden="true" />
      <div className="so-glow so-glow-purple" aria-hidden="true" />

      {/* Center card */}
      <div className="so-center">

        {isLoading ? (
          /* ── Signing-in state: centered spinner ── */
          <div className="so-signing-in">
            <span className="material-symbols-outlined so-signing-in-spinner">progress_activity</span>
            <p className="so-signing-in-label">Signing in…</p>
          </div>
        ) : (
          /* ── Signed-out state: logo + CTA ── */
          <>
            {/* Orbiting stars and particles */}
            <div className="so-orbit-container" aria-hidden="true">
              {/* Orbit ring 1 — close, fast */}
              <div className="so-orbit so-orbit-1">
                <div className="so-star so-star-a" />
                <div className="so-star so-star-b" />
                <div className="so-star so-star-c" />
              </div>
              {/* Orbit ring 2 — medium distance */}
              <div className="so-orbit so-orbit-2">
                <div className="so-particle so-particle-a" />
                <div className="so-particle so-particle-b" />
                <div className="so-star so-star-d" />
                <div className="so-particle so-particle-c" />
              </div>
              {/* Orbit ring 3 — wide, slow */}
              <div className="so-orbit so-orbit-3">
                <div className="so-star so-star-e" />
                <div className="so-particle so-particle-d" />
                <div className="so-star so-star-f" />
                <div className="so-particle so-particle-e" />
                <div className="so-particle so-particle-f" />
              </div>

              {/* Logo mark */}
              <div className="so-icon-ring">
                <AnimatedCrystalBall width={96} height={96} aria-hidden="true" />
              </div>
            </div>

            <h1 className="so-headline">BigQuery AIF</h1>
            <p className="so-subline">Ask anything about your BigQuery data</p>

            {/* Sign-in CTA */}
            <button
              className="so-signin-cta"
              onClick={signIn}
              id="sign-in-btn-landing"
              aria-label="Sign in with Google"
            >
              <svg viewBox="0 0 18 18" width="20" height="20" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
              </svg>
              Sign in with Google
            </button>

            {error && (
              <div style={{
                color: '#ea4335',
                fontSize: 12,
                marginTop: 12,
                textAlign: 'center',
                maxWidth: 280,
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            <p className="so-footer-note">
              Your Google account determines which BigQuery projects are available
            </p>
          </>
        )}

      </div>
    </div>
  );
}
