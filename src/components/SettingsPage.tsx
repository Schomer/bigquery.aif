'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';

interface TokenInfo {
  issued_to?: string;
  audience?: string;
  user_id?: string;
  scope?: string;
  expires_in?: number;
  email?: string;
  error?: string;
  error_description?: string;
}

export function SettingsPage() {
  const { user, accessToken, signOut } = useAuth();
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapsKey, setMapsKey] = useState('');
  const [mapsKeySaved, setMapsKeySaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('google_maps_api_key');
    if (stored) setMapsKey(stored);
  }, []);

  useEffect(() => {
    if (accessToken) {
      runDiagnostics();
    }
  }, [accessToken]);

  async function runDiagnostics() {
    if (!accessToken) {
      setError('No active Google access token found in session storage.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`);
      const data = await res.json();
      setTokenInfo(data);
      if (data.error || data.error_description) {
        setError(data.error_description || data.error || 'Failed to fetch token info from Google APIs.');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  const scopes = tokenInfo?.scope ? tokenInfo.scope.split(' ') : [];
  const hasBigQueryScope = scopes.some((s) => s.includes('bigquery'));
  const hasCloudPlatformScope = scopes.some((s) => s.includes('cloud-platform'));

  return (
    <div className="settings-page" style={{ padding: '32px', maxWidth: '800px', margin: '0 auto', color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'var(--accent)' }}>settings</span>
        <h1 style={{ fontSize: '28px', fontWeight: 500, margin: 0, letterSpacing: '-0.5px' }}>Settings & Diagnostics</h1>
      </div>

      <p style={{ color: 'var(--text-muted)', marginBottom: '32px', fontSize: '14px', lineHeight: 1.6 }}>
        Use this diagnostics dashboard to troubleshoot credentials, verify active Google OAuth scopes, and check API token status.
      </p>

      {/* ── Section: User Identity ── */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 500, marginTop: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>account_circle</span>
          User Session
        </h2>
        
        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <img 
              src={user.picture} 
              alt={user.name} 
              style={{ width: '48px', height: '48px', borderRadius: '50%', border: '1px solid var(--border)' }}
              referrerPolicy="no-referrer" 
            />
            <div>
              <div style={{ fontWeight: 500, fontSize: '15px' }}>{user.name}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{user.email}</div>
            </div>
            <button 
              onClick={signOut}
              className="gc-sign-in-btn"
              style={{ marginLeft: 'auto', padding: '8px 16px', background: 'none', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer', color: 'var(--text)' }}
            >
              Sign Out
            </button>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Not signed in.</div>
        )}
      </div>

      {/* ── Section: OAuth Token Diagnostics ── */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 500, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>key</span>
            Google OAuth 2.0 Access Token
          </h2>
          <button 
            onClick={runDiagnostics} 
            disabled={loading}
            style={{ 
              padding: '6px 12px', 
              background: 'var(--surface)', 
              border: '1px solid var(--border)', 
              borderRadius: '6px', 
              cursor: loading ? 'not-allowed' : 'pointer', 
              color: 'var(--text)',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
            Run Diagnostics
          </button>
        </div>

        {accessToken ? (
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Token Preview</div>
                <code style={{ display: 'block', background: 'var(--surface)', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', border: '1px solid var(--border)', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {accessToken.substring(0, 12)}...{accessToken.substring(accessToken.length - 12)}
                </code>
              </div>

              {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Querying Google Token Info...</div>}

              {error && (
                <div style={{ background: '#fdeded', border: '1px solid #f5c2c2', color: '#c62828', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className="material-symbols-outlined">warning</span>
                  <div>
                    <strong>Diagnostics Failed:</strong> {error}
                  </div>
                </div>
              )}

              {tokenInfo && !tokenInfo.error && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Target Audience:</span>
                    <code>{tokenInfo.issued_to}</code>
                    
                    <span style={{ color: 'var(--text-muted)' }}>Expires In:</span>
                    <span>{tokenInfo.expires_in ? `${Math.round(tokenInfo.expires_in / 60)} minutes (${tokenInfo.expires_in}s)` : 'Expired'}</span>
                  </div>

                  <div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>Authorized Scopes</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {scopes.map((scope) => {
                        const isBigQuery = scope.includes('bigquery');
                        const isCloudPlatform = scope.includes('cloud-platform');
                        const highlight = isBigQuery || isCloudPlatform;
                        return (
                          <span 
                            key={scope} 
                            style={{ 
                              fontSize: '11px', 
                              padding: '4px 8px', 
                              borderRadius: '4px', 
                              background: highlight ? '#e3f2fd' : 'var(--surface)', 
                              color: highlight ? '#0d47a1' : 'var(--text-muted)', 
                              border: highlight ? '1px solid #bbdefb' : '1px solid var(--border)',
                              fontFamily: 'monospace'
                            }}
                          >
                            {scope}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── Scope Status Checks ── */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                      <span className="material-symbols-outlined" style={{ color: hasBigQueryScope ? '#2e7d32' : '#c23330' }}>
                        {hasBigQueryScope ? 'check_circle' : 'cancel'}
                      </span>
                      <span>BigQuery Access Scope: <strong>{hasBigQueryScope ? 'Authorized' : 'Missing'}</strong></span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                      <span className="material-symbols-outlined" style={{ color: hasCloudPlatformScope ? '#2e7d32' : '#c23330' }}>
                        {hasCloudPlatformScope ? 'check_circle' : 'cancel'}
                      </span>
                      <span>Cloud Platform Scope: <strong>{hasCloudPlatformScope ? 'Authorized' : 'Missing'}</strong></span>
                    </div>
                  </div>

                  {(!hasBigQueryScope || !hasCloudPlatformScope) && (
                    <div style={{ background: '#fff8e1', border: '1px solid #ffe082', color: '#b78103', borderRadius: '8px', padding: '16px', fontSize: '13px', marginTop: '12px', lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                        <span className="material-symbols-outlined">info</span>
                        Missing Required Scopes
                      </div>
                      Your token does not have permission to access BigQuery. To resolve:
                      <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                        <li>Click <strong>Sign Out</strong> above.</li>
                        <li>Click <strong>Sign In with Google</strong>.</li>
                        <li>In the Google sign-in window, make sure to <strong>check the checkboxes</strong> for BigQuery and Google Cloud Platform scopes.</li>
                      </ol>
                    </div>
                  )}

                  {hasBigQueryScope && hasCloudPlatformScope && (
                    <div style={{ background: '#e8f5e9', border: '1px solid #a5d6a7', color: '#2e7d32', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', marginTop: '12px' }}>
                      <div style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className="material-symbols-outlined">verified</span>
                        All Credentials Valid
                      </div>
                      <div style={{ marginTop: '4px' }}>Your browser has a valid token with both BigQuery and Cloud Platform scopes authorized.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ color: '#c23330', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="material-symbols-outlined">warning</span>
            No active Google Access Token found in session. Please sign in.
          </div>
        )}
      </div>

      {/* ── Section: Google Maps API Key ── */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 500, marginTop: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>map</span>
          Google Maps API Key
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: 0, marginBottom: '12px', lineHeight: 1.5 }}>
          Required for map-based visualizations (geo point maps, US state maps, world maps). Create a key in the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Google Cloud Console</a> with the Maps JavaScript API enabled.
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="password"
            value={mapsKey}
            onChange={(e) => { setMapsKey(e.target.value); setMapsKeySaved(false); }}
            placeholder="AIza..."
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text)',
              fontSize: '13px',
              fontFamily: 'monospace',
            }}
          />
          <button
            onClick={() => {
              if (mapsKey.trim()) {
                localStorage.setItem('google_maps_api_key', mapsKey.trim());
              } else {
                localStorage.removeItem('google_maps_api_key');
              }
              setMapsKeySaved(true);
            }}
            style={{
              padding: '8px 16px',
              background: 'var(--accent, #4f7fff)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Save
          </button>
        </div>
        {mapsKeySaved && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#2e7d32', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check_circle</span>
            API key saved to browser storage.
          </div>
        )}
      </div>
    </div>
  );
}
