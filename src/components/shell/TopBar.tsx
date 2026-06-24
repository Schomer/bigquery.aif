'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useLayout, type ChatLayout } from '@/lib/layout-context';

interface TopBarProps {
  onNavToggle: () => void;
}

const FAVORITES_KEY = 'hdn_favorite_projects';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
  } catch { /* ignore */ }
}

export function TopBar({ onNavToggle }: TopBarProps) {
  const { user, accessToken, projects, activeProject, isLoading, signIn, signOut, setActiveProject } = useAuth();
  const { layout, setLayout } = useLayout();

  const LAYOUT_OPTIONS: { value: ChatLayout; icon: string; label: string; flip?: boolean }[] = [
    { value: 'unified', icon: 'view_stream', label: 'Unified' },
    { value: 'chat-left', icon: 'side_navigation', label: 'Chat left' },
    { value: 'chat-right', icon: 'side_navigation', label: 'Chat right', flip: true },
  ];

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [liveResults, setLiveResults] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load favorites from localStorage on mount
  useEffect(() => {
    setFavorites(loadFavorites());
  }, []);

  // Focus search when dropdown opens; clear live results on close
  useEffect(() => {
    if (projectMenuOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearch('');
      setLiveResults([]);
    }
  }, [projectMenuOpen]);

  // Live search: CRM full-text search + direct BQ probe (debounced 280ms)
  useEffect(() => {
    const q = search.trim();
    if (!q || !accessToken) {
      setLiveResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const found = new Set<string>();

      await Promise.allSettled([
        // ── 1. CRM v3 full-text search ──────────────────────────────
        (async () => {
          const url = new URL('https://cloudresourcemanager.googleapis.com/v3/projects:search');
          url.searchParams.set('query', q);
          url.searchParams.set('pageSize', '50');
          const res = await fetch(url.toString(), { headers });
          if (!res.ok) return;
          const data = await res.json();
          for (const p of data.projects ?? []) {
            const id: string = p.projectId ?? p.name?.split('/').pop() ?? '';
            if (id) found.add(id);
          }
        })(),

        // ── 2. CRM v1 prefix filter on project ID ───────────────────
        (async () => {
          const url = new URL('https://cloudresourcemanager.googleapis.com/v1/projects');
          url.searchParams.set('filter', `id:${q}* lifecycleState:ACTIVE`);
          url.searchParams.set('pageSize', '50');
          const res = await fetch(url.toString(), { headers });
          if (!res.ok) return;
          const data = await res.json();
          for (const p of data.projects ?? []) {
            if (p.projectId) found.add(p.projectId);
          }
        })(),

        // ── 3. Direct BQ probe — works even without Resource Manager IAM ──
        // If the user has BigQuery access to a project, BQ returns 200.
        // We probe the exact query string as a project ID.
        (async () => {
          // Only probe if the query looks like a project ID (no spaces)
          if (/\s/.test(q)) return;
          const probeId = q.toLowerCase();
          const res = await fetch(
            `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(probeId)}/datasets?maxResults=1`,
            { headers }
          );
          // 200 = access confirmed, 403 = project exists but no dataset access
          // Both mean the project is real and the user has some BQ access
          if (res.status === 200 || res.status === 403) {
            found.add(probeId);
          }
        })(),
      ]);

      setLiveResults([...found]);
      setIsSearching(false);
    }, 280);

    return () => clearTimeout(timer);
  }, [search, accessToken]);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node)) {
        setAvatarMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggleFavorite = useCallback((e: React.MouseEvent, projectId: string) => {
    e.stopPropagation(); // don't select the project
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveFavorites(next);
      return next;
    });
  }, []);

  const DEFAULT_VISIBLE = 20;

  // Favorites + first 20 others by default.
  // When searching: merge local matches + live API results, deduped.
  const { favoritedProjects, otherProjects, totalOtherCount } = useMemo(() => {
    const q = search.trim().toLowerCase();

    // ALL starred IDs — regardless of whether they're in the pre-fetched list
    const favoritedProjects = [...favorites];
    const nonFavs = projects.filter((p) => !favorites.has(p));

    if (q) {
      // Local matches
      const localFavMatches = favoritedProjects.filter((p) => p.toLowerCase().includes(q));
      const localOtherMatches = nonFavs.filter((p) => p.toLowerCase().includes(q));

      // Merge live API results (deduped, excluding favorites)
      const seen = new Set<string>([...localFavMatches, ...localOtherMatches]);
      const liveExtra: string[] = [];
      for (const p of liveResults) {
        if (!seen.has(p)) {
          seen.add(p);
          if (favorites.has(p)) localFavMatches.push(p);
          else liveExtra.push(p);
        }
      }

      const allOthers = [...localOtherMatches, ...liveExtra];
      return { favoritedProjects: localFavMatches, otherProjects: allOthers, totalOtherCount: allOthers.length };
    }

    // Default: favorites + first 20
    return {
      favoritedProjects,
      otherProjects: nonFavs.slice(0, DEFAULT_VISIBLE),
      totalOtherCount: nonFavs.length,
    };
  }, [projects, favorites, search, liveResults]);

  const renderProject = (p: string) => (
    <div key={p} className="gc-project-option-wrap">
      <button
        role="option"
        aria-selected={p === activeProject}
        className={`gc-project-option${p === activeProject ? ' gc-project-option--active' : ''}`}
        onClick={() => { setActiveProject(p); setProjectMenuOpen(false); }}
      >
        <span className="material-symbols-outlined gc-project-option-icon">dataset</span>
        <span className="gc-project-option-label">{p}</span>
        {p === activeProject && (
          <span className="material-symbols-outlined gc-project-option-check">check</span>
        )}
      </button>
      <button
        className={`gc-project-star${favorites.has(p) ? ' gc-project-star--active' : ''}`}
        aria-label={favorites.has(p) ? `Unstar ${p}` : `Star ${p}`}
        title={favorites.has(p) ? 'Remove from favorites' : 'Add to favorites'}
        onClick={(e) => toggleFavorite(e, p)}
      >
        <span className="material-symbols-outlined">
          {favorites.has(p) ? 'star' : 'star_border'}
        </span>
      </button>
    </div>
  );

  return (
    <header className="gc-top-bar">
      {/* ── Left ── */}
      <div className="gc-top-bar-start">
        <button className="gc-icon-btn" id="nav-toggle" aria-label="Toggle navigation" onClick={onNavToggle}>
          <span className="material-symbols-outlined">menu</span>
        </button>

        {/* Google Cloud wordmark */}
        <div className="gc-logo" aria-label="Google Cloud">
          <svg viewBox="0 19 1060 173" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="Google Cloud" role="img">
            <path d="M678.011 152.95c-19.009 0-34.86-6.376-47.553-19.129-12.693-12.812-19.039-28.841-19.039-48.089 0-19.307 6.376-35.247 19.128-47.82C643.3 25.337 659.091 19.05 677.921 19.05c6.138 0 12.067.804 17.788 2.413 5.721 1.61 10.905 3.904 15.553 6.883 4.708 2.92 9.624 7.15 14.749 12.693L712.424 53.91c-4.41-4.708-8.194-8.045-11.352-10.011-3.099-1.966-6.555-3.456-10.369-4.47-3.813-1.072-8.044-1.608-12.692-1.608-13.289 0-24.432 4.41-33.43 13.229-8.998 8.76-13.497 20.29-13.497 34.592 0 14.242 4.469 25.892 13.407 34.949 8.939 8.998 20.112 13.497 33.52 13.497 4.707 0 9.236-.655 13.586-1.966s8.313-3.158 11.889-5.542c3.575-2.383 7.448-5.899 11.62-10.547l13.944 13.318c-5.721 6.376-11.114 11.114-16.179 14.212-5.006 3.099-10.428 5.423-16.268 6.972-5.84 1.609-12.037 2.414-18.592 2.414zm60.878-2.95V22h19.486v128h-19.486zm78.104 2.95c-13.884 0-25.355-4.619-34.413-13.855-9.058-9.236-13.586-20.856-13.586-34.86 0-14.183 4.528-25.832 13.586-34.95 9.117-9.117 20.588-13.676 34.413-13.676 13.825 0 25.296 4.589 34.414 13.766 9.117 9.177 13.675 20.797 13.675 34.86 0 14.004-4.528 25.624-13.586 34.86s-20.559 13.855-34.503 13.855zm0-16.983c8.164 0 15.017-2.95 20.559-8.85 5.542-5.959 8.313-13.586 8.313-22.882 0-9.415-2.801-17.043-8.402-22.883-5.542-5.84-12.365-8.76-20.47-8.76-8.163 0-15.016 2.92-20.558 8.76s-8.313 13.468-8.313 22.883c0 9.296 2.741 16.923 8.223 22.882 5.542 5.9 12.425 8.85 20.648 8.85zm91.797 16.983c-10.845 0-19.217-3.129-25.117-9.386-5.899-6.316-8.849-15.225-8.849-26.726V58.559h19.486v55.329c0 7.449 1.698 13.14 5.095 17.073 3.456 3.933 8.372 5.899 14.748 5.899 6.675 0 12.306-2.562 16.894-7.687 4.589-5.184 6.883-11.381 6.883-18.592V58.559h19.486V150h-18.503v-21.721l8.849 8.85h-9.385c-2.563 4.588-6.555 8.372-11.978 11.351-5.422 2.98-11.292 4.47-17.609 4.47zm102.62 0c-12.45 0-22.789-4.499-31.012-13.497-8.164-9.058-12.246-20.768-12.246-35.129 0-14.242 4.141-25.892 12.424-34.95 8.343-9.057 18.771-13.586 31.284-13.586 6.32 0 12.13 1.43 17.43 4.29 5.36 2.801 9.39 6.496 12.07 11.084h.62V22.001h19.31V150h-18.59v-16.179l2.05 3.576h-2.59c-2.86 4.707-7.06 8.491-12.6 11.352-5.54 2.8-11.59 4.201-18.15 4.201zm3.49-16.805c7.81 0 14.36-2.979 19.66-8.938 5.37-6.019 8.05-13.676 8.05-22.972 0-9.296-2.71-16.864-8.13-22.704-5.37-5.84-11.89-8.76-19.58-8.76-7.69 0-14.24 2.92-19.665 8.76-5.363 5.84-8.044 13.438-8.044 22.793 0 9.237 2.652 16.864 7.955 22.883 5.364 5.959 11.944 8.938 19.754 8.938zM528.355 152.631c-13.706 0-25.058-4.41-34.056-13.229-8.938-8.819-13.407-20.439-13.407-34.86 0-14.123 4.32-25.743 12.96-34.86 8.701-9.177 20.052-13.766 34.056-13.766 9.177 0 17.102 2.354 23.777 7.062 6.733 4.707 12.037 12.067 15.91 22.078.358 1.013.685 2.056.983 3.128.298 1.073.566 2.294.805 3.665l-73.296 31.106-5.095-14.749 60.693-25.742-1.699 8.134c-2.264-6.376-5.423-10.995-9.475-13.855-3.992-2.86-8.432-4.29-13.318-4.29-8.343 0-14.987 2.86-19.933 8.58-4.946 5.662-7.419 13.11-7.419 22.347 0 8.7 2.861 16.119 8.581 22.257 5.721 6.137 12.663 9.206 20.827 9.206 4.886 0 9.445-1.221 13.676-3.665 4.231-2.443 7.925-5.869 11.083-10.279l14.481 9.475c-4.052 6.674-9.594 12.067-16.626 16.179-7.031 4.052-14.867 6.078-23.508 6.078zM451.305 149.859v-128h19.486v128h-19.486zM186.279 152.809c-9.177 0-17.431-2.116-24.76-6.347-7.27-4.23-12.961-10.04-17.073-17.43-4.052-7.448-6.078-15.821-6.078-25.117 0-9.534 2.086-17.966 6.257-25.296 4.231-7.389 9.981-13.11 17.251-17.162 7.27-4.052 15.404-6.078 24.403-6.078 9.117 0 17.31 2.056 24.58 6.168 7.33 4.111 13.08 9.862 17.252 17.251 4.171 7.39 6.257 15.762 6.257 25.117 0 9.296-2.056 17.669-6.168 25.117-4.112 7.449-9.832 13.289-17.162 17.52-7.27 4.171-15.523 6.257-24.759 6.257zm0-16.983c5.661 0 10.666-1.401 15.016-4.201 4.41-2.861 7.807-6.704 10.19-11.531 2.443-4.886 3.665-10.279 3.665-16.179 0-5.84-1.222-11.143-3.665-15.91-2.383-4.827-5.78-8.64-10.19-11.442-4.409-2.8-9.415-4.2-15.016-4.2-5.244 0-10.071 1.34-14.481 4.022-4.409 2.681-7.925 6.435-10.547 11.262-2.563 4.767-3.844 10.19-3.844 16.268 0 5.84 1.192 11.203 3.576 16.09 2.443 4.826 5.839 8.67 10.189 11.53 4.41 2.861 9.446 4.291 15.107 4.291zM391.506 191.335c-10.249 0-18.711-2.146-25.385-6.436-6.614-4.291-12.127-11.114-16.536-20.469l16.804-7.419c2.801 5.303 6.198 9.445 10.19 12.424 3.993 3.039 8.879 4.559 14.659 4.559 8.82 0 15.523-2.563 20.112-7.687 4.648-5.125 6.972-12.276 6.972-21.453v-8.312h-.626c-1.43 2.145-3.456 4.32-6.078 6.525-2.622 2.145-5.84 3.992-9.654 5.542-3.813 1.489-7.985 2.234-12.513 2.234-8.999 0-16.805-1.996-23.419-5.989-6.615-3.992-11.68-9.534-15.196-16.625-3.516-7.151-5.274-15.345-5.274-24.581 0-9.117 1.758-17.281 5.274-24.492 3.516-7.27 8.522-12.96 15.017-17.072 6.555-4.112 14.182-6.168 22.882-6.168 6.198 0 11.889 1.222 17.073 3.665 5.184 2.443 9.236 5.93 12.156 10.458h.358V58.687h18.592v80.625c0 34.682-15.136 52.023-45.408 52.023zm0-58.19c5.483 0 10.25-1.281 14.302-3.844 4.052-2.562 7.151-6.108 9.296-10.636 2.145-4.589 3.218-9.803 3.218-15.643 0-5.959-1.073-11.173-3.218-15.642-2.145-4.53-5.244-8.015-9.296-10.458-4.052-2.444-8.79-3.665-14.212-3.665-5.304 0-9.982 1.251-14.034 3.754-4.052 2.443-7.21 5.93-9.474 10.458-2.265 4.529-3.397 9.743-3.397 15.643 0 6.197 1.132 11.56 3.397 16.089 2.324 4.529 5.512 7.985 9.564 10.369 4.052 2.383 8.67 3.575 13.854 3.575zM290.233 152.809c-9.177 0-17.43-2.116-24.76-6.347-7.27-4.23-12.96-10.04-17.072-17.43-4.052-7.448-6.078-15.821-6.078-25.117 0-9.534 2.085-17.966 6.257-25.296 4.231-7.389 9.981-13.11 17.251-17.162 7.27-4.052 15.404-6.078 24.402-6.078 9.117 0 17.311 2.056 24.581 6.168 7.33 4.111 13.08 9.862 17.251 17.251 4.172 7.39 6.257 15.762 6.257 25.117 0 9.296-2.056 17.669-6.167 25.117-4.112 7.449-9.833 13.289-17.162 17.52-7.27 4.171-15.523 6.257-24.76 6.257zm0-16.983c5.661 0 10.667-1.401 15.017-4.201 4.409-2.861 7.806-6.704 10.19-11.531 2.443-4.886 3.664-10.279 3.664-16.179 0-5.84-1.221-11.143-3.664-15.91-2.384-4.827-5.781-8.64-10.19-11.442-4.41-2.8-9.415-4.2-15.017-4.2-5.244 0-10.071 1.34-14.48 4.022-4.41 2.681-7.926 6.435-10.548 11.262-2.562 4.767-3.843 10.19-3.843 16.268 0 5.84 1.192 11.203 3.575 16.09 2.443 4.826 5.84 8.67 10.19 11.53 4.41 2.861 9.445 4.291 15.106 4.291zM66.145 152.809c-12.276-.119-23.478-3.158-33.609-9.117-10.07-6.019-18.026-14.153-23.866-24.402C2.89 109.04 0 97.778 0 85.502c0-12.454 2.89-23.746 8.67-33.876 5.78-10.13 13.736-18.086 23.866-23.866C42.666 21.92 53.93 19 66.324 19c9.653 0 18.502 1.609 26.547 4.827 8.045 3.218 14.898 8.164 20.559 14.838L100.469 52.25c-5.065-5.184-10.28-8.908-15.643-11.173-5.303-2.264-11.381-3.397-18.234-3.397-8.7 0-16.566 1.967-23.598 5.9-7.031 3.933-12.603 9.564-16.715 16.894-4.052 7.27-6.078 15.702-6.078 25.296 0 9.355 2.026 17.728 6.078 25.117 4.052 7.329 9.594 13.05 16.626 17.162 7.031 4.111 14.927 6.167 23.687 6.167 7.806 0 14.778-1.37 20.916-4.111 6.197-2.801 11.203-6.973 15.017-12.514 3.813-5.542 6.108-12.276 6.882-20.201h-43.53V78.888h62.033c.596 3.933.894 7.508.894 10.726 0 12.514-2.592 23.598-7.777 33.251-5.184 9.594-12.543 17.013-22.078 22.257-9.475 5.244-20.41 7.807-32.804 7.687z" fill="#212226"/>
          </svg>
        </div>

        {/* Project picker chip */}
        <div className="gc-project-picker-wrap" ref={projectMenuRef}>
          <button
            className="gc-env-chip"
            aria-haspopup="listbox"
            aria-expanded={projectMenuOpen}
            onClick={() => {
              if (!user) { signIn(); return; }
              setProjectMenuOpen((o) => !o);
            }}
            aria-label={user ? `Active project: ${activeProject || 'Select project'}` : 'Sign in to pick a project'}
          >
            <svg className="gc-env-chip-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path fill="#1B2E5D" fillRule="evenodd" d="m10.557 11.99-1.71-2.966 1.71-3.015h3.42l1.71 3.01-1.71 2.964h-3.42zM4.023 16l-1.71-2.966 1.71-3.015h3.42l1.71 3.01L7.443 16zm0-8.016-1.71-2.966 1.71-3.015h3.42l1.71 3.015-1.71 2.966z"/>
            </svg>
            <span className="gc-env-chip-label">
              {user ? (activeProject || 'Select project') : 'Sign in'}
            </span>
            {user && (
              <span className="material-symbols-outlined gc-env-chip-caret">arrow_drop_down</span>
            )}
          </button>

          {projectMenuOpen && user && (
            <div className="gc-project-dropdown" role="listbox" aria-label="BigQuery projects">
              {/* Search field */}
              <div className="gc-project-search-wrap">
                <span className="material-symbols-outlined gc-project-search-icon">search</span>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="gc-project-search-input"
                  placeholder="Search all projects…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Search projects"
                />
                {isSearching && (
                  <span
                    className="material-symbols-outlined gc-project-search-spinner"
                    aria-label="Searching…"
                  >progress_activity</span>
                )}
                {search && !isSearching && (
                  <button className="gc-project-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </div>

              <div className="gc-project-dropdown-body">
                {/* Favorites section */}
                {favoritedProjects.length > 0 && (
                  <>
                    <div className="gc-project-section-label">
                      <span className="material-symbols-outlined gc-project-section-star">star</span>
                      Starred
                    </div>
                    {favoritedProjects.map(renderProject)}
                    {otherProjects.length > 0 && <div className="gc-project-section-divider" />}
                  </>
                )}

                {/* All other projects */}
                {otherProjects.length > 0 && (
                  <>
                    {favoritedProjects.length > 0 && (
                      <div className="gc-project-section-label">All projects</div>
                    )}
                    {favoritedProjects.length === 0 && (
                      <div className="gc-project-dropdown-header">Your projects</div>
                    )}
                    {otherProjects.map(renderProject)}
                  </>
                )}

                {/* Empty state */}
                {favoritedProjects.length === 0 && otherProjects.length === 0 && (
                  <div className="gc-project-dropdown-empty">
                    {search ? `No projects matching "${search}"` : 'No projects found'}
                  </div>
                )}

                {/* Truncation hint */}
                {!search && totalOtherCount > DEFAULT_VISIBLE && (
                  <div className="gc-project-more-hint">
                    <span className="material-symbols-outlined">manage_search</span>
                    {totalOtherCount - DEFAULT_VISIBLE} more · search to find them
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: utility icons + auth ── */}
      <div className="gc-top-bar-end">
        {/* Layout switcher */}
        <div className="layout-seg" role="radiogroup" aria-label="Chat layout">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="radio"
              aria-checked={layout === opt.value}
              aria-label={opt.label}
              data-tooltip={opt.label}
              className={`layout-seg-btn${layout === opt.value ? ' layout-seg-btn--active' : ''}${opt.flip ? ' layout-seg-btn--flip' : ''}`}
              onClick={() => setLayout(opt.value)}
            >
              <span className="material-symbols-outlined">{opt.icon}</span>
            </button>
          ))}
        </div>
        {/* Gemini */}
        <button className="gc-icon-btn" aria-label="Gemini">
          <svg viewBox="0 0 256 256" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M128 256q0-26.56-10.24-49.92-9.92-23.36-27.2-40.64c-17.28-17.28-25.067-20.587-40.64-27.2Q26.56 128 0 128q26.56 0 49.92-9.92 23.36-10.24 40.64-27.52c17.28-17.28 20.587-25.067 27.2-40.64Q128 26.56 128 0q0 26.56 9.92 49.92 10.24 23.36 27.52 40.64c17.28 17.28 25.067 20.693 40.64 27.52Q229.44 128 256 128q-26.56 0-49.92 10.24-23.36 9.92-40.64 27.2c-17.28 17.28-20.693 25.067-27.52 40.64Q128 229.44 128 256"/>
          </svg>
        </button>

        {/* Notifications */}
        <button className="gc-icon-btn" aria-label="Notifications">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M18 17v-6c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v6H4v2h16v-2zm-2 0H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5zm-4 5c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2"/>
          </svg>
        </button>

        {/* ── Avatar / auth menu ── */}
        {isLoading ? (
          <div className="gc-avatar-loading" aria-label="Signing in…">
            <span className="material-symbols-outlined gc-avatar-loading-icon">progress_activity</span>
          </div>
        ) : user ? (
          <div className="gc-avatar-wrap" ref={avatarMenuRef}>
            <button
              className="gc-avatar-btn"
              onClick={() => setAvatarMenuOpen((o) => !o)}
              aria-label={`Account menu for ${user.email}`}
              aria-expanded={avatarMenuOpen}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="gc-avatar" src={user.picture} alt={user.name} referrerPolicy="no-referrer" />
            </button>

            {avatarMenuOpen && (
              <div className="gc-avatar-menu" role="menu">
                <div className="gc-avatar-menu-info">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="gc-avatar-menu-photo" src={user.picture} alt={user.name} referrerPolicy="no-referrer" />
                  <div>
                    <div className="gc-avatar-menu-name">{user.name}</div>
                    <div className="gc-avatar-menu-email">{user.email}</div>
                  </div>
                </div>
                <hr className="gc-avatar-menu-divider" />
                <button className="gc-avatar-menu-item" role="menuitem" onClick={() => { signOut(); setAvatarMenuOpen(false); }}>
                  <span className="material-symbols-outlined">logout</span>
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="gc-sign-in-btn" onClick={signIn} id="sign-in-btn">
            <span className="material-symbols-outlined">account_circle</span>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
