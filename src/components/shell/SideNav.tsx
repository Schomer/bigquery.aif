'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useConversation } from '@/lib/conversation-context';
import { usePage } from '@/lib/page-context';
import {
  getConversations,
  deleteConversation,
  saveConversation,
  type SavedConversation,
} from '@/lib/firestore-service';

interface NavItem {
  label: string;
  icon: string;
  page: string;
  active?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Data',
    items: [
      { label: 'Datasets', icon: 'dataset', page: 'datasets' },
      { label: 'Tables', icon: 'table_chart', page: 'tables' },
      { label: 'Schema Explorer', icon: 'account_tree', page: 'schema' },
    ],
  },
  {
    label: 'Queries',
    items: [
      { label: 'Saved Queries', icon: 'manage_search', page: 'saved-queries' },
      { label: 'Query History', icon: 'history', page: 'query-history' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Cost', icon: 'payments', page: 'cost' },
    ],
  },
];

function relativeLabel(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'Last 7 days';
  return 'Older';
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Last 7 days', 'Older'];

interface SideNavProps {
  collapsed: boolean;
}

export function SideNav({ collapsed }: SideNavProps) {
  const { user } = useAuth();
  const { conversationId, loadConversation, newConversation } = useConversation();
  const { activePage, setActivePage } = usePage();
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [navGroupsOpen, setNavGroupsOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(NAV_GROUPS.map((g) => [g.label, true]))
  );


  const loadConvs = useCallback(() => {
    if (!user) return;
    getConversations(user.uid).then(setConversations).catch(() => {});
  }, [user]);

  useEffect(() => { loadConvs(); }, [loadConvs]);

  // Refresh list when conversationId changes (new conversation saved)
  useEffect(() => { loadConvs(); }, [conversationId, loadConvs]);

  async function handleDelete(id: string) {
    if (!user) return;
    await deleteConversation(user.uid, id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) newConversation();
  }

  async function handleRename(id: string) {
    if (!user || !renameValue.trim()) { setRenamingId(null); return; }
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, title: renameValue.trim() };
    await saveConversation(user.uid, updated);
    setConversations((prev) => prev.map((c) => c.id === id ? updated : c));
    setRenamingId(null);
  }

  // Group conversations by recency
  const grouped = conversations.reduce<Record<string, SavedConversation[]>>((acc, c) => {
    const label = relativeLabel(c.updatedAt);
    if (!acc[label]) acc[label] = [];
    acc[label].push(c);
    return acc;
  }, {});

  return (
    <nav className={`gc-side-nav${collapsed ? ' gc-side-nav--collapsed' : ''}`} id="side-nav" aria-label="Primary navigation">

      <div className="gc-nav-top">

        {/* Product header */}
        <div className="gc-nav-header">
          <img src="/crystal-ball.svg" width={26} height={26} aria-hidden="true" alt="" />
          <span className="gc-nav-header-text">BigQuery AIF</span>
        </div>

        {/* New CTA */}
        <div className="gc-nav-cta-wrap">
          <button
            className="gc-nav-cta"
            id="new-btn"
            aria-label="New conversation"
            onClick={() => newConversation()}
          >
            <span className="material-symbols-outlined">add</span>
            <span className="gc-nav-cta-label">New</span>
          </button>
        </div>

        {/* Top-level items */}
        <div className="gc-nav-section">
          {[
            { label: 'Overview', icon: 'home', page: 'overview' },
            { label: 'Chat', icon: 'chat', page: 'chat' },
            { label: 'Favorites', icon: 'star', page: 'favorites' },
            { label: 'Prompts', icon: 'bookmark', page: 'prompts' },
          ].map((item) => (
            <div className="gc-nav-item-row" key={item.page}>
              <a
                className={`gc-nav-item${activePage === item.page ? ' gc-nav-item--active' : ''}`}
                href="#"
                data-page={item.page}
                onClick={(e) => { e.preventDefault(); setActivePage(item.page); }}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className="gc-nav-label">{item.label}</span>
              </a>
            </div>
          ))}
        </div>

        {/* Recents */}
        {!collapsed && conversations.length > 0 && (
          <div className="gc-nav-group">
            <button className="gc-nav-group-header" onClick={() => setRecentsOpen((o) => !o)}>
              <span className="gc-nav-group-label">Recents</span>
              <span className="material-symbols-outlined gc-nav-group-chevron">
                {recentsOpen ? 'expand_less' : 'expand_more'}
              </span>
            </button>
            {recentsOpen && (
              <div className="gc-nav-group-items">
                {GROUP_ORDER.filter((g) => grouped[g]?.length).map((group) => (
                  <div key={group}>
                    <p style={{ margin: '8px 16px 2px', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{group}</p>
                    {grouped[group].slice(0, 5).map((conv) => (
                      <div
                        key={conv.id}
                        className="gc-nav-item-row"
                        style={{ position: 'relative' }}
                        onMouseEnter={(e) => e.currentTarget.querySelector<HTMLElement>('.conv-actions')!.style.opacity = '1'}
                        onMouseLeave={(e) => e.currentTarget.querySelector<HTMLElement>('.conv-actions')!.style.opacity = '0'}
                      >
                        {renamingId === conv.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => handleRename(conv.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(conv.id); if (e.key === 'Escape') setRenamingId(null); }}
                            style={{ flex: 1, margin: '0 8px', padding: '4px 8px', fontSize: 12, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--surface)', color: 'var(--text)', outline: 'none', fontFamily: 'inherit' }}
                          />
                        ) : (
                          <a
                            className={`gc-nav-item${conv.id === conversationId ? ' gc-nav-item--active' : ''}`}
                            href="#"
                            data-page="chat"
                            onClick={(e) => { e.preventDefault(); loadConversation(conv.id); setActivePage('chat'); }}
                            style={collapsed ? undefined : { paddingRight: 56 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16, opacity: 0.6 }}>chat_bubble</span>
                            <span className="gc-nav-label" style={{ fontSize: 12 }}>{conv.title}</span>
                          </a>
                        )}
                        <div
                          className="conv-actions"
                          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 2, opacity: 0, transition: 'opacity 0.1s' }}
                        >
                          <button
                            title="Rename"
                            onClick={() => { setRenamingId(conv.id); setRenameValue(conv.title); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 3, borderRadius: 4 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>edit</span>
                          </button>
                          <button
                            title="Delete"
                            onClick={() => handleDelete(conv.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 3, borderRadius: 4 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>delete</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Grouped nav items */}
        {NAV_GROUPS.map((group) => (
          <div className="gc-nav-group" key={group.label}>
            <button className="gc-nav-group-header" onClick={() => setNavGroupsOpen((o) => ({ ...o, [group.label]: !o[group.label] }))}>
              <span className="gc-nav-group-label">{group.label}</span>
              <span className="material-symbols-outlined gc-nav-group-chevron">
                {navGroupsOpen[group.label] ? 'expand_less' : 'expand_more'}
              </span>
            </button>
            {navGroupsOpen[group.label] && (
              <div className="gc-nav-group-items">
                {group.items.map((item) => (
                  <div className="gc-nav-item-row" key={item.page}>
                    <a className="gc-nav-item" href="#" data-page={item.page}>
                      <span className="material-symbols-outlined">{item.icon}</span>
                      <span className="gc-nav-label">{item.label}</span>
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

      </div>

      {/* Bottom utility */}
      <div className="gc-nav-bottom">
        <a className="gc-nav-item" href="#" data-page="settings">
          <span className="material-symbols-outlined">settings</span>
          <span className="gc-nav-label">Settings</span>
        </a>
      </div>

    </nav>
  );
}
