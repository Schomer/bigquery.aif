'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { AnimatedCrystalBall } from '@/components/AnimatedCrystalBall';
import { SparkSpinner } from '@/components/SparkSpinner';
import { CrystalBallOracle } from '@/components/CrystalBallOracle';
import { EmptyCanvasAnimation } from '@/components/EmptyCanvasAnimation';
import { useAuth } from '@/lib/auth-context';
import { useConversation } from '@/lib/conversation-context';
import { usePage } from '@/lib/page-context';
import { useLayout } from '@/lib/layout-context';
import type { ChatMessage, CompositionEnvelope, SkillName, DataManagementResult, HandoffEnvelope, ContextItem } from '@/lib/types';
import { ChatOrchestrator } from '@/lib/chat-orchestrator';
import { ArtifactCard } from '@/components/ArtifactCard';
import { PromptsLibrary } from '@/components/PromptsLibrary';
import { SettingsPage } from '@/components/SettingsPage';
import {
  saveConversation,
  getConversations,
  getRecentDatasets,
  autoTitle,
  nowISO,
} from '@/lib/firestore-service';
import type { RecentItem } from '@/lib/firestore-service';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

// ── Crystal-ball thinking indicator ──────────────────────────────────────────
const THINKING_PHRASES = [
  'Gazing into the warehouse…',
  'Reading the query leaves…',
  'The crystals are computing…',
  'Communing with the schema…',
  'Divining your results…',
  'Scanning the data plane…',
  'Interrogating the cosmos…',
  'Decoding the data stream…',
];

function CrystalBallThinking() {
  const [phrase, setPhrase] = useState(() => {
    const idx = Math.floor(Math.random() * THINKING_PHRASES.length);
    return THINKING_PHRASES[idx];
  });
  const current = useRef(phrase);

  useEffect(() => {
    const id = setInterval(() => {
      const pool = THINKING_PHRASES.filter(p => p !== current.current);
      const next = pool[Math.floor(Math.random() * pool.length)];
      current.current = next;
      setPhrase(next);
    }, 2800);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 0 8px',
    }}>
      <SparkSpinner size={24} />
      <span style={{
        fontSize: 13,
        fontStyle: 'italic',
        color: 'var(--text-muted)',
        fontFamily: "'Google Sans', 'Inter', sans-serif",
        letterSpacing: '0.01em',
        transition: 'opacity 0.4s ease',
      }}>
        {phrase}
      </span>
    </div>
  );
}

export default function Home() {
  const { activeProject, user } = useAuth();
  const { conversationId, newConversation } = useConversation();
  const { activePage, setActivePage } = usePage();
  const { layout } = useLayout();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [rerunningIdx, setRerunningIdx] = useState<number | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [context, setContext] = useState<{
    lastSkill?: SkillName;
    lastResultRef?: string;
    lastTable?: string;
    dataset?: string;
    project?: string;
  }>({});
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [pinnedEnvelopeId, setPinnedEnvelopeId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{ message: string; type: string; sql?: string; retryFn?: () => void } | null>(null);
  const [thinkingSteps, setThinkingSteps] = useState<Record<number, string[]>>({});
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('hdn_sidebar_width');
      if (stored) return Math.max(280, Math.min(600, parseInt(stored, 10)));
    }
    return 380;
  });
  const [isDragging, setIsDragging] = useState(false);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleSetRef = useRef(false);
  const resultsPanelRef = useRef<HTMLDivElement>(null);
  const pendingStepsRef = useRef<string[]>([]);

  // Auto-focus and auto-size the edit textarea when it opens
  useEffect(() => {
    if (editingIdx !== null && editTextareaRef.current) {
      const el = editTextareaRef.current;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      autoResizeEl(el);
    }
  }, [editingIdx]);

  const autoResizeEl = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const maxHeight = Math.round(14 * 1.5 * 8 + 2); // 8 lines max
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    // 5 lines x 14px font x 1.5 line-height + 2px padding buffer
    const maxHeight = Math.round(14 * 1.5 * 5 + 2);
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  };

  useEffect(() => {
    if (inputRef.current) {
      autoResize(inputRef.current);
    }
  }, [input]);
  useEffect(() => {
    if (!user) return;
    setMessages([]);
    setContext({});
    setContextItems([]);
    setPinnedEnvelopeId(null);
    titleSetRef.current = false;

    getConversations(user.uid).then((convs) => {
      const match = convs.find((c) => c.id === conversationId);
      if (match) {
        setMessages(match.messages);
      }
    }).catch(() => {});
  }, [conversationId, user]);

  // Load recently-used datasets/tables once on mount
  useEffect(() => {
    if (!user) return;
    getRecentDatasets(user.uid).then(setRecentItems).catch(() => {});
  }, [user]);



  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-save conversation to Firestore after each assistant reply
  const persistConversation = useCallback(async (msgs: ChatMessage[]) => {
    if (!user || msgs.length === 0) return;
    const firstUserMsg = msgs.find((m) => m.role === 'user')?.content ?? 'New conversation';
    const title = titleSetRef.current
      ? undefined
      : autoTitle(firstUserMsg);
    if (title) titleSetRef.current = true;

    const existing = await getConversations(user.uid).then((c) => c.find((x) => x.id === conversationId)).catch(() => undefined);

    await saveConversation(user.uid, {
      id: conversationId,
      title: title ?? existing?.title ?? autoTitle(firstUserMsg),
      createdAt: existing?.createdAt ?? nowISO(),
      updatedAt: nowISO(),
      project: activeProject || context.project || '',
      messages: msgs,
    });
  }, [user, conversationId, activeProject, context.project]);

  // Submit an edited user message at `userIdx`, replacing it and the following assistant reply
  async function submitEdit(userIdx: number) {
    const text = editText.trim();
    if (!text || loading) return;
    setEditingIdx(null);
    setLoading(true);
    setRerunningIdx(userIdx + 1);
    pendingStepsRef.current = [];

    const historyBefore = messages.slice(0, userIdx);
    const editedUserMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    try {
      const data = await ChatOrchestrator.processMessage({
        message: text,
        history: historyBefore,
        context: { ...deriveContextFromItems(), project: activeProject || context.project, uid: user?.uid },
        onStatus: (s: string) => { setStatusText(s); pendingStepsRef.current.push(s); },
      });
      const envelopes: CompositionEnvelope[] = data.envelopes ?? [];
      const newAssistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        envelopes,
        timestamp: new Date().toISOString(),
      };

      // Replace the user message and its immediately following assistant message
      const tail = messages.slice(userIdx + 1);
      const nextAssistantOffset = tail.findIndex((m) => m.role === 'assistant');
      const updatedMsgs = [
        ...historyBefore,
        editedUserMsg,
        newAssistantMsg,
        // Keep any messages after the replaced assistant response
        ...(nextAssistantOffset >= 0 ? tail.slice(nextAssistantOffset + 1) : []),
      ];
      setMessages(updatedMsgs);
      const newAssistantIdx = updatedMsgs.findIndex((m) => m === newAssistantMsg);
      if (newAssistantIdx >= 0) {
        setThinkingSteps((prev) => ({ ...prev, [newAssistantIdx]: [...pendingStepsRef.current] }));
      }
      persistConversation(updatedMsgs).catch((e) => console.warn('[persist]', e));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setStatusText(null);
      setRerunningIdx(null);
    }
  }

  // Re-run the user prompt that preceded message at index `assistantIdx`
  async function rerunMessage(assistantIdx: number) {
    if (loading) return;
    setRerunningIdx(assistantIdx);
    pendingStepsRef.current = [];
    // Find the most recent user message before assistantIdx
    let userText = '';
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        break;
      }
    }
    if (!userText) return;

    // Truncate messages up to (but not including) the assistant message
    const historyUpTo = messages.slice(0, assistantIdx);
    setLoading(true);

    try {
      const data = await ChatOrchestrator.processMessage({
        message: userText,
        history: historyUpTo.slice(0, -1),
        context: { ...deriveContextFromItems(), project: activeProject || context.project, uid: user?.uid },
        onStatus: (s: string) => { setStatusText(s); pendingStepsRef.current.push(s); },
      });
      const envelopes: CompositionEnvelope[] = data.envelopes ?? [];
      const newAssistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        envelopes,
        timestamp: new Date().toISOString(),
      };

      // Replace the assistant message at assistantIdx with the new one
      const updatedMsgs = [
        ...messages.slice(0, assistantIdx),
        newAssistantMsg,
        ...messages.slice(assistantIdx + 1),
      ];
      setMessages(updatedMsgs);
      setThinkingSteps((prev) => ({ ...prev, [assistantIdx]: [...pendingStepsRef.current] }));
      persistConversation(updatedMsgs).catch((e) => console.warn('[persist]', e));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setStatusText(null);
      setRerunningIdx(null);
    }
  }

  async function sendMessage(messageText?: string) {
    const text = messageText ?? input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);
    pendingStepsRef.current = [];

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    const updatedMsgs = [...messages, userMsg];
    setMessages(updatedMsgs);

    try {
      const derivedCtx = deriveContextFromItems();
      const data = await ChatOrchestrator.processMessage({
        message: text,
        history: messages,
        context: { ...derivedCtx, project: activeProject || derivedCtx.project, uid: user?.uid },
        onStatus: (s: string) => { setStatusText(s); pendingStepsRef.current.push(s); },
      });

      const envelopes: CompositionEnvelope[] = data.envelopes ?? [];

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        envelopes,
        timestamp: new Date().toISOString(),
      };

      const finalMsgs = [...updatedMsgs, assistantMsg];
      setMessages(finalMsgs);
      const assistantIdx = finalMsgs.length - 1;
      setThinkingSteps((prev) => ({ ...prev, [assistantIdx]: [...pendingStepsRef.current] }));

      if (envelopes.length > 0) {
        const last = envelopes[envelopes.length - 1];
        setContext((prev) => ({
          ...prev,
          lastSkill: last.skill,
          lastResultRef: last.id,
          ...extractContextFromEnvelope(last),
        }));
        // Auto-populate context chips from the last envelope
        const autoItems = extractContextItems(last);
        if (autoItems.length > 0) {
          setContextItems(autoItems);
          setPinnedEnvelopeId(null);
        }
      }

      setLastError(null);
      // Persist to Firestore — fire and forget, never surface Firestore errors to the user
      persistConversation(finalMsgs).catch((e) => console.warn('[persist]', e));

    } catch (err: any) {
      console.error(err);
      const msg = err?.message || String(err);
      
      let errorType = 'unknown';
      let errorText = msg;

      if (msg.includes('Gemini API failed')) {
        errorType = 'gemini';
        errorText = msg.replace('Gemini API failed: ', '');
      } else if (msg.includes('access token') || msg.includes('credentials') || msg.includes('access_denied') || msg.includes('UNAUTHENTICATED') || msg.includes('authorized') || msg.includes('access not authorized') || msg.includes('sign in')) {
        errorType = 'auth';
        errorText = 'Your session has expired. Please sign in again.';
      } else if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
        errorType = 'rate_limit';
        errorText = 'The service is temporarily busy. Try again in a few seconds.';
      } else if (msg.includes('Syntax error') || msg.includes('query failed')) {
        errorType = 'sql';
        errorText = msg.replace('BigQuery query failed: ', '');
      }

      const retryFn = () => sendMessage(text);
      setLastError({ message: errorText, type: errorType, retryFn });

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
      setStatusText(null);
      inputRef.current?.focus();
    }
  }

  async function handleConfirm(envelope: CompositionEnvelope) {
    setLoading(true);
    try {
      const data = await ChatOrchestrator.processMessage({
        message: 'confirm',
        history: messages,
        context: { ...deriveContextFromItems(), project: activeProject || context.project, uid: user?.uid, confirmedPayload: envelope.primaryArtifact.data as DataManagementResult },
        onStatus: (s: string) => setStatusText(s),
      });
      const envelopes: CompositionEnvelope[] = data.envelopes ?? [];
      const assistantMsg: ChatMessage = { role: 'assistant', content: '', envelopes, timestamp: new Date().toISOString() };
      const finalMsgs = [...messages, assistantMsg];
      setMessages(finalMsgs);
      persistConversation(finalMsgs).catch((e) => console.warn('[persist]', e));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleCancel(envelope: CompositionEnvelope) {
    // Remove the message containing this envelope from the conversation
    setMessages((prev) =>
      prev.map((msg) =>
        msg.envelopes?.some((e) => e.id === envelope.id)
          ? { ...msg, envelopes: msg.envelopes?.filter((e) => e.id !== envelope.id) }
          : msg
      ).filter((msg) => !msg.envelopes || msg.envelopes.length > 0 || msg.content)
    );
  }

  function extractContextFromEnvelope(env: CompositionEnvelope): Partial<typeof context> {
    const data = env.primaryArtifact.data as Record<string, unknown> | null;
    if (!data) return {};
    const result: Partial<typeof context> = {};

    // Schema results
    if (data.dataset && typeof data.dataset === 'string') result.dataset = data.dataset;
    if (data.table && typeof data.table === 'string') result.lastTable = data.table;

    // Query results -- extract table from SQL
    if (data.sql && typeof data.sql === 'string') {
      const sqlMatch = (data.sql as string).match(/\bFROM\s+`?([A-Za-z0-9_.-]+)`?/i);
      if (sqlMatch) {
        const parts = sqlMatch[1].split('.');
        if (parts.length >= 3) result.dataset = parts[parts.length - 2];
        result.lastTable = parts[parts.length - 1];
      }
    }

    // Data quality / data management -- table field is fully qualified
    if (env.skill === 'data-quality' || env.skill === 'data-management') {
      const tableFq = data.table as string | undefined;
      if (tableFq && typeof tableFq === 'string') {
        const parts = tableFq.replace(/`/g, '').split('.');
        if (parts.length >= 2) result.dataset = parts[parts.length - 2];
        result.lastTable = parts[parts.length - 1];
      }
    }

    return result;
  }

  // Extract structured context items from an envelope for the chips row
  function extractContextItems(env: CompositionEnvelope): ContextItem[] {
    const items: ContextItem[] = [];
    const data = env.primaryArtifact.data as Record<string, unknown> | null;
    if (!data) return items;

    let ds: string | undefined;
    let tbl: string | undefined;
    const sql = (data.sql as string | undefined) || env.provenance.sql;

    // Schema results
    if (data.dataset && typeof data.dataset === 'string') ds = data.dataset;
    if (data.table && typeof data.table === 'string') tbl = data.table;

    // Query results -- extract from SQL
    if (sql) {
      const sqlMatch = sql.match(/\bFROM\s+`?([A-Za-z0-9_.-]+)`?/i);
      if (sqlMatch) {
        const parts = sqlMatch[1].split('.');
        if (parts.length >= 3 && !ds) ds = parts[parts.length - 2];
        if (!tbl) tbl = parts[parts.length - 1];
      }
    }

    // Data quality / data management
    if (env.skill === 'data-quality' || env.skill === 'data-management') {
      const tableFq = data.table as string | undefined;
      if (tableFq && typeof tableFq === 'string') {
        const parts = tableFq.replace(/`/g, '').split('.');
        if (parts.length >= 2 && !ds) ds = parts[parts.length - 2];
        if (!tbl) tbl = parts[parts.length - 1];
      }
    }

    if (ds) {
      items.push({
        id: `ds_${env.id}`,
        type: 'dataset',
        label: ds,
        icon: 'dataset',
        dataset: ds,
      });
    }

    if (tbl) {
      items.push({
        id: `tbl_${env.id}`,
        type: 'table',
        label: tbl,
        icon: 'table_chart',
        dataset: ds,
        table: tbl,
      });
    }

    // Result reference for query/chart/table results
    const rowCount = Array.isArray(data.rows) ? (data.rows as unknown[]).length : null;
    if (rowCount !== null && env.primaryArtifact.type !== 'SCHEMA_VIEW') {
      items.push({
        id: `res_${env.id}`,
        type: 'result',
        label: `${rowCount} rows`,
        icon: 'query_stats',
        dataset: ds,
        table: tbl,
        skill: env.skill,
        resultRef: env.id,
        sql: sql,
      });
    }

    return items;
  }

  function removeContextItem(id: string) {
    setContextItems((prev) => prev.filter((item) => item.id !== id));
  }

  function pinEnvelopeContext(env: CompositionEnvelope) {
    const items = extractContextItems(env);
    if (items.length === 0) return;
    setContextItems(items);
    setPinnedEnvelopeId(env.id);
    inputRef.current?.focus();
  }

  // Derive the flat context object the orchestrator expects from contextItems
  function deriveContextFromItems(): typeof context {
    const dsItem = contextItems.find((i) => i.type === 'dataset');
    const tblItem = contextItems.find((i) => i.type === 'table');
    const resItem = contextItems.find((i) => i.type === 'result');
    return {
      ...context,
      dataset: dsItem?.dataset ?? context.dataset,
      lastTable: tblItem?.table ?? context.lastTable,
      lastSkill: resItem?.skill ?? context.lastSkill,
      lastResultRef: resItem?.resultRef ?? context.lastResultRef,
    };
  }

  async function handleChipClick(chip: HandoffEnvelope) {
    if (loading) return;
    setLoading(true);
    setLastError(null);

    const chipContext = chip.context as Record<string, unknown>;

    const userMsg: ChatMessage = {
      role: 'user',
      content: chip.label,
      timestamp: new Date().toISOString(),
    };
    const updatedMsgs = [...messages, userMsg];
    setMessages(updatedMsgs);

    try {
      const mergedContext = {
        ...deriveContextFromItems(),
        project: activeProject || context.project,
        uid: user?.uid,
        forcedSkill: chip.targetSkill as SkillName,
        ...(chipContext.dataset ? { dataset: String(chipContext.dataset) } : {}),
        ...(chipContext.table ? { lastTable: String(chipContext.table) } : {}),
        // Pass full handoff context so handlers can use structured fields
        // (operationHint, checkType, monitoringHint, filter, etc.)
        handoffContext: chipContext,
      };

      // Build a more explicit message from chip context
      let enrichedMessage = chip.label;
      if (chipContext.sql && typeof chipContext.sql === 'string') {
        enrichedMessage = `${chip.label}. Use this SQL: ${chipContext.sql}`;
      } else if (chipContext.table && typeof chipContext.table === 'string') {
        enrichedMessage = `${chip.label} for table ${chipContext.table}`;
      } else if (chipContext.dataset && typeof chipContext.dataset === 'string') {
        enrichedMessage = `${chip.label} in dataset ${chipContext.dataset}`;
      }

      const data = await ChatOrchestrator.processMessage({
        message: enrichedMessage,
        history: messages,
        context: mergedContext,
        onStatus: (s: string) => setStatusText(s),
      });

      const envelopes: CompositionEnvelope[] = data.envelopes ?? [];
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        envelopes,
        timestamp: new Date().toISOString(),
      };

      const finalMsgs = [...updatedMsgs, assistantMsg];
      setMessages(finalMsgs);

      if (envelopes.length > 0) {
        const last = envelopes[envelopes.length - 1];
        setContext((prev) => ({
          ...prev,
          lastSkill: last.skill,
          lastResultRef: last.id,
          ...extractContextFromEnvelope(last),
        }));
        const autoItems = extractContextItems(last);
        if (autoItems.length > 0) {
          setContextItems(autoItems);
          setPinnedEnvelopeId(null);
        }
      }

      setLastError(null);
      persistConversation(finalMsgs).catch((e) => console.warn('[persist]', e));
    } catch (err: any) {
      console.error(err);
      const msg = err?.message || String(err);
      setLastError({ message: msg, type: 'unknown', retryFn: () => handleChipClick(chip) });
      setMessages((prev) => [...prev, { role: 'assistant', content: '', timestamp: new Date().toISOString() }]);
    } finally {
      setLoading(false);
      setStatusText(null);
    }
  }

  function handleInlineClick(message: string) {
    sendMessage(message);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }



  const hasChat = messages.length > 0;
  const isSplit = layout === 'chat-left' || layout === 'chat-right';

  // Map artifact types to Material Symbols icon names
  const artifactIcon = useCallback((type: string): string => {
    if (type === 'TABLE') return 'table_chart';
    if (type === 'SCHEMA_VIEW') return 'schema';
    if (type === 'KPI_CARD') return 'speed';
    if (type === 'DATA_QUALITY_VIEW') return 'verified';
    if (type === 'DISCOVERY_VIEW') return 'explore';
    if (type === 'MONITORING_VIEW') return 'monitoring';
    if (type === 'CONFIRMATION_CARD' || type === 'COST_CONFIRM_CARD') return 'check_circle';
    if (type === 'COMPLETION_CARD') return 'task_alt';
    if (type === 'DATA_LOADING_VIEW') return 'download';
    if (type === 'MULTISTEP_VIEW') return 'account_tree';
    // All chart types
    return 'bar_chart';
  }, []);

  // Generate a meaningful label from the envelope's actual data
  const envelopeLabel = useCallback((env: CompositionEnvelope): string => {
    const { type, data } = env.primaryArtifact;
    if (type === 'SCHEMA_VIEW') {
      const d = data as any;
      if (d?.scope === 'DATASET' && d?.columns?.length) return `${d.columns.length} tables`;
      if (d?.scope === 'TABLE' && d?.table) return d.table;
      if (d?.scope === 'PROJECT') return 'Datasets';
      return 'Schema';
    }
    if (type === 'TABLE') {
      const d = data as any;
      if (d?.rows?.length !== undefined) return `${d.rows.length} rows`;
      return 'Table';
    }
    if (type === 'KPI_CARD') return 'KPI';
    if (type === 'DATA_QUALITY_VIEW') {
      const d = data as any;
      return d?.table ? `Quality: ${d.table}` : 'Quality';
    }
    if (type === 'DISCOVERY_VIEW') return 'Discovery';
    if (type === 'MONITORING_VIEW') return 'Monitor';
    if (type === 'CONFIRMATION_CARD' || type === 'COST_CONFIRM_CARD') return 'Confirm';
    if (type === 'COMPLETION_CARD') return 'Done';
    if (type === 'DATA_LOADING_VIEW') return 'Export';
    if (type === 'MULTISTEP_VIEW') return 'Workflow';
    // Charts: use a readable name
    const chartNames: Record<string, string> = {
      LINE_CHART: 'Line chart', BAR_CHART: 'Bar chart', AREA_CHART: 'Area chart',
      PIE_CHART: 'Pie chart', DONUT_CHART: 'Donut chart', COLUMN_CHART: 'Column chart',
      SCATTER: 'Scatter plot', HISTOGRAM: 'Histogram', HEATMAP: 'Heatmap',
      FUNNEL: 'Funnel', TREEMAP: 'Treemap', GAUGE: 'Gauge',
    };
    return chartNames[type] || 'Chart';
  }, []);

  // Scroll the results panel to a specific envelope card
  const scrollToResult = useCallback((envelopeId: string) => {
    const panel = resultsPanelRef.current;
    if (!panel) return;
    const card = panel.querySelector(`[data-envelope-id="${envelopeId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('result-card-highlight');
      // Force reflow to restart the animation
      void (card as HTMLElement).offsetWidth;
      card.classList.add('result-card-highlight');
    }
  }, []);

  // Drag handle for resizing sidebar
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const isRight = layout === 'chat-right';

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      // If sidebar is on the right, dragging left increases width
      const newWidth = isRight ? startWidth - delta : startWidth + delta;
      setSidebarWidth(Math.max(280, Math.min(600, newWidth)));
    };
    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth, layout]);

  // Persist sidebar width
  useEffect(() => {
    localStorage.setItem('hdn_sidebar_width', String(sidebarWidth));
  }, [sidebarWidth]);

  // In split mode, collect all envelopes from all assistant messages for the results panel
  const allEnvelopes = (() => {
    if (!isSplit) return [];
    const result: CompositionEnvelope[] = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.envelopes?.length) {
        result.push(...msg.envelopes);
      }
    }
    return result;
  })();

  // Shared send button
  const sendButton = (
    <button
      onClick={() => sendMessage()}
      disabled={loading || !input.trim() || !activeProject}
      style={{
        width: 34,
        height: 34,
        flexShrink: 0,
        borderRadius: '50%',
        background: input.trim() ? '#bfdbfe' : 'var(--surface)',
        border: `1px solid ${input.trim() ? '#93c5fd' : 'var(--border)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: input.trim() ? 'pointer' : 'default',
        transition: 'all 0.15s',
        padding: 0,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5" stroke={input.trim() ? '#1d4ed8' : 'var(--text-muted)'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );

  // Shared textarea props builder
  const inputTextarea = (placeholder: string) => (
    <textarea
      ref={inputRef}
      value={input}
      onChange={(e) => { setInput(e.target.value); autoResize(e.target); }}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      disabled={!activeProject}
      rows={1}
      style={{
        flex: 1,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        color: 'var(--text)',
        fontSize: 14,
        resize: 'none',
        lineHeight: 1.5,
        fontFamily: 'inherit',
        alignSelf: 'center',
        opacity: activeProject ? 1 : 0.5,
        cursor: activeProject ? 'text' : 'not-allowed',
      }}
    />
  );

  // Shared context chips row (above textarea)
  const contextChipsRow = contextItems.length > 0 ? (
    <div className="context-chips-row">
      {contextItems.map((item) => (
        <span key={item.id} className="context-chip">
          <span className="material-symbols-outlined">{item.icon}</span>
          {item.label}
          <button
            className="context-chip-dismiss"
            onClick={() => removeContextItem(item.id)}
            aria-label={`Remove ${item.label}`}
          >
            x
          </button>
        </span>
      ))}
    </div>
  ) : null;

  // Error card renderer (used in both unified and split modes)
  const renderErrorCard = () => {
    if (!lastError) return null;
    return (
      <div style={{
        background: lastError.type === 'auth' ? '#fff7ed' : lastError.type === 'rate_limit' ? '#fffbeb' : '#fef2f2',
        border: `1px solid ${lastError.type === 'auth' ? '#fed7aa' : lastError.type === 'rate_limit' ? '#fde68a' : '#fecaca'}`,
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-outlined" style={{
            fontSize: 18,
            color: lastError.type === 'auth' ? '#c2410c' : lastError.type === 'rate_limit' ? '#b45309' : '#dc2626',
          }}>
            {lastError.type === 'auth' ? 'lock' : lastError.type === 'rate_limit' ? 'schedule' : lastError.type === 'sql' ? 'code_off' : 'warning'}
          </span>
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            color: lastError.type === 'auth' ? '#c2410c' : lastError.type === 'rate_limit' ? '#b45309' : '#dc2626',
          }}>
            {lastError.type === 'auth' ? 'Session Expired'
              : lastError.type === 'rate_limit' ? 'Temporarily Busy'
              : lastError.type === 'sql' ? 'Query Error'
              : lastError.type === 'gemini' ? 'AI Service Error'
              : 'Something Went Wrong'}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
          {typeof lastError.message === 'string' ? lastError.message : String(lastError.message ?? '')}
        </p>
        {lastError.sql && (
          <div className="sql-block" style={{ fontSize: 11, marginTop: 4 }}>{lastError.sql}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {lastError.retryFn && (
            <button
              onClick={() => { setLastError(null); lastError.retryFn?.(); }}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  };

  // Regenerate button renderer
  const renderRegenerate = (i: number) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 }}>
      {rerunningIdx === i ? (
        <CrystalBallThinking />
      ) : (
        <button
          id={`regenerate-btn-${i}`}
          onClick={() => rerunMessage(i)}
          disabled={loading}
          title="Regenerate response"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'none',
            border: '1px solid transparent',
            borderRadius: 6,
            padding: '3px 8px 3px 4px',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: 'var(--text-muted)',
            fontSize: 12,
            opacity: loading ? 0.4 : 0.6,
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!loading) {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)';
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '0.6';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
            (e.currentTarget as HTMLButtonElement).style.background = 'none';
          }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 14, lineHeight: 1, fontVariationSettings: `'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 20` }}
          >redo</span>
          Regenerate
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* -- Settings page -- */}
      {activePage === 'settings' && (
        <SettingsPage />
      )}

      {/* -- Prompts page (full inline view) -- */}
      {activePage === 'prompts' && (
        <PromptsLibrary
          open
          inline
          onClose={() => setActivePage('chat')}
          onUsePrompt={(text) => { setInput(text); setActivePage('chat'); inputRef.current?.focus(); }}
        />
      )}

      {/* ============================================================
         UNIFIED LAYOUT (original single-pane)
         ============================================================ */}
      {!isSplit && (
        <div style={{ display: (activePage === 'prompts' || activePage === 'settings') ? 'none' : 'flex', flexDirection: 'column', height: '100%', background: 'var(--chat-bg)' }}>

          {/* -- EMPTY STATE: centered hero + prompt -- */}
          {!hasChat && (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}>
              <CrystalBallOracle ballSize={88} />
                <h1 style={{ fontSize: 22, fontWeight: 500, color: 'var(--text)', margin: '20px 0 6px', letterSpacing: '-0.2px' }}>
                  BigQuery AIF
                </h1>
                <p style={{ color: 'var(--text-muted)', margin: '0 0 32px', fontSize: 14 }}>
                  Ask anything about your data
                </p>

                {!activeProject && (
                  <div style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: '14px 20px',
                    marginBottom: 20,
                    maxWidth: 640,
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text-muted)',
                    fontSize: 13,
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#f59e0b' }}>info</span>
                    Select a GCP project from the sidebar to get started.
                  </div>
                )}

                {/* Recently-used datasets / tables */}
                {activeProject && recentItems.length > 0 && (
                  <div className="recent-items-section">
                    <div className="recent-items-label">Recent</div>
                    <div className="recent-items">
                      {recentItems.map((item, idx) => (
                        <button
                          key={`${item.type}-${item.name}-${idx}`}
                          className="recent-item-chip"
                          onClick={() => {
                            if (item.type === 'table' && item.dataset) {
                              sendMessage(`Show me the schema for ${item.dataset}.${item.name}`);
                            } else if (item.type === 'table') {
                              sendMessage(`Show me the schema for ${item.name}`);
                            } else {
                              sendMessage(`What tables are in the ${item.name} dataset?`);
                            }
                          }}
                        >
                          <span className="material-symbols-outlined">
                            {item.type === 'table' ? 'table_chart' : 'dataset'}
                          </span>
                          {item.name}
                          {item.type === 'table' && item.dataset && (
                            <span className="recent-item-chip-sub">{item.dataset}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

              {/* Centered prompt field */}
              <div className="mystic-prompt-container" style={{
                width: '100%',
                maxWidth: 640,
                borderRadius: contextItems.length > 0 ? 20 : 999,
                padding: contextItems.length > 0 ? '8px 10px 10px 14px' : '10px 10px 10px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: contextItems.length > 0 ? 6 : 0,
              }}>
                {contextChipsRow}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                  {inputTextarea(activeProject ? 'Ask about your data...' : 'Select a project first...')}
                  {sendButton}
                </div>
              </div>
            </div>
          )}

          {/* -- ACTIVE CHAT: scrollable message thread -- */}
          {hasChat && (
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '24px 24px 140px',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
            }}>
              {messages.map((msg, i) => (
                <div key={i} className={i > 0 ? 'fade-up' : ''}>
                  {msg.role === 'user' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: 4 }}>
                      {editingIdx === i ? (
                        /* -- Edit mode -- */
                        <div style={{
                          maxWidth: '70%',
                          width: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          alignItems: 'flex-end',
                        }}>
                          <textarea
                            ref={editTextareaRef}
                            value={editText}
                            onChange={(e) => { setEditText(e.target.value); autoResizeEl(e.target); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(i); }
                              if (e.key === 'Escape') { setEditingIdx(null); }
                            }}
                            rows={1}
                            style={{
                              width: '100%',
                              background: 'var(--surface)',
                              border: '1.5px solid #93c5fd',
                              borderRadius: '12px 12px 4px 12px',
                              padding: '10px 14px',
                              fontSize: 14,
                              color: 'var(--text)',
                              lineHeight: 1.5,
                              resize: 'none',
                              outline: 'none',
                              fontFamily: 'inherit',
                              boxShadow: '0 0 0 3px rgba(147,197,253,0.25)',
                              transition: 'border-color 0.15s',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => setEditingIdx(null)}
                              style={{
                                padding: '4px 12px',
                                borderRadius: 6,
                                border: '1px solid var(--border)',
                                background: 'var(--surface-2)',
                                color: 'var(--text-muted)',
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >Cancel</button>
                            <button
                              onClick={() => submitEdit(i)}
                              disabled={!editText.trim() || loading}
                              style={{
                                padding: '4px 14px',
                                borderRadius: 6,
                                border: '1px solid #93c5fd',
                                background: '#bfdbfe',
                                color: '#1d4ed8',
                                fontSize: 12,
                                fontWeight: 500,
                                cursor: !editText.trim() || loading ? 'not-allowed' : 'pointer',
                                opacity: !editText.trim() || loading ? 0.5 : 1,
                              }}
                            >Save</button>
                          </div>
                        </div>
                      ) : (
                        /* -- View mode -- */
                        <div
                          role="button"
                          tabIndex={0}
                          title="Click to edit"
                          onClick={() => { if (!loading) { setEditingIdx(i); setEditText(msg.content); } }}
                          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !loading) { setEditingIdx(i); setEditText(msg.content); } }}
                          style={{
                            maxWidth: '70%',
                            background: 'var(--accent-dim)',
                            borderRadius: '16px 16px 4px 16px',
                            padding: '10px 16px',
                            fontSize: 14,
                            color: '#3c4043',
                            lineHeight: 1.5,
                            cursor: loading ? 'default' : 'text',
                            userSelect: 'text',
                          }}
                        >
                          {typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')}
                        </div>
                      )}
                      {/* Regenerate button under user prompt */}
                      {i + 1 < messages.length && messages[i + 1].role === 'assistant' && renderRegenerate(i + 1)}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {msg.envelopes?.map((env) => (
                        <ArtifactCard
                          key={env.id}
                          envelope={env}
                          onConfirm={() => handleConfirm(env)}
                          onCancel={() => handleCancel(env)}
                          onChipClick={handleChipClick}
                          onInlineClick={handleInlineClick}
                          onPin={extractContextItems(env).length > 0 ? pinEnvelopeContext : undefined}
                          isPinned={pinnedEnvelopeId === env.id}
                        />
                      ))}
                      {!msg.envelopes && msg.content && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                          {typeof msg.content === 'string' ? msg.content : String(msg.content)}
                        </div>
                      )}
                      {/* Error card */}
                      {!msg.envelopes && !msg.content && lastError && i === messages.length - 1 && renderErrorCard()}
                    </div>
                  )}
                </div>
              ))}

              {loading && rerunningIdx === null && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 0 8px',
                }}>
                  <SparkSpinner size={24} />
                  <span style={{
                    fontSize: 13,
                    fontStyle: 'italic',
                    color: 'var(--text-muted)',
                    fontFamily: "'Google Sans', 'Inter', sans-serif",
                    letterSpacing: '0.01em',
                    transition: 'opacity 0.4s ease',
                  }}>
                    {statusText || 'Processing...'}
                  </span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}

          {/* -- Floating prompt bar (active chat only) -- */}
          {hasChat && (
            <div className="mystic-prompt-container" style={{
              position: 'fixed',
              bottom: 28,
              left: '50%',
              transform: 'translateX(-50%)',
              marginLeft: 110,
              width: 'min(680px, calc(100vw - 268px))',
              borderRadius: contextItems.length > 0 ? 20 : 999,
              padding: contextItems.length > 0 ? '8px 10px 10px 14px' : '10px 10px 10px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: contextItems.length > 0 ? 6 : 0,
              backdropFilter: 'blur(12px)',
              zIndex: 50,
            }}>
              {contextChipsRow}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                {inputTextarea(activeProject ? 'Ask a follow-up...' : 'Select a project first...')}
                {sendButton}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================
         SPLIT LAYOUT (chat sidebar + results panel)
         ============================================================ */}
      {isSplit && (
        <div
          className={`layout-split ${layout === 'chat-right' ? 'layout-chat-right' : 'layout-chat-left'}`}
          style={{ display: (activePage === 'prompts' || activePage === 'settings') ? 'none' : 'flex', height: '100%' }}
        >
          {/* -- Chat sidebar -- */}
          <div className="chat-sidebar" style={{ width: sidebarWidth, minWidth: 280, maxWidth: 600 }}>
            <div className="chat-sidebar-messages">
              {!hasChat && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Start a conversation...
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i}>
                  {msg.role === 'user' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      <div className="chat-sidebar-user-msg">
                        {typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')}
                      </div>
                      {/* Regenerate button under user prompt */}
                      {i + 1 < messages.length && messages[i + 1].role === 'assistant' && renderRegenerate(i + 1)}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {/* Show text summary in sidebar */}
                      {msg.envelopes && msg.envelopes.length > 0 && (
                        <div className="chat-sidebar-assistant-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {msg.envelopes.map((env) => env.headline.text).join(' ')}
                        </div>
                      )}
                      {!msg.envelopes && msg.content && (
                        <div className="chat-sidebar-assistant-text">
                          {typeof msg.content === 'string' ? msg.content : String(msg.content)}
                        </div>
                      )}

                      {/* Artifact link buttons */}
                      {msg.envelopes && msg.envelopes.length > 0 && (
                        <div className="chat-sidebar-artifact-links">
                          {msg.envelopes.map((env) => (
                            <button
                              key={env.id}
                              className="chat-sidebar-artifact-link"
                              onClick={() => scrollToResult(env.id)}
                              title={`View in results panel`}
                            >
                              <span className="material-symbols-outlined">{artifactIcon(env.primaryArtifact.type)}</span>
                              {envelopeLabel(env)}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Show thinking (collapsible) */}
                      {(thinkingSteps[i]?.length || (msg.envelopes && msg.envelopes.some((e) => e.provenance.sql || e.skill))) && (
                        <details className="chat-sidebar-thinking">
                          <summary>
                            <span className="material-symbols-outlined">chevron_right</span>
                            Show thinking
                          </summary>
                          <div className="chat-sidebar-thinking-body">
                            {/* Processing steps as simple numbered list */}
                            {thinkingSteps[i] && thinkingSteps[i].length > 0 && (
                              <>
                                <div className="thinking-section-label">Steps</div>
                                {thinkingSteps[i].map((step, si) => (
                                  <div key={si} className="thinking-step">
                                    {si + 1}. {step}
                                  </div>
                                ))}
                              </>
                            )}

                            {/* Details from each envelope */}
                            {msg.envelopes && msg.envelopes.map((env) => {
                              const d = env.primaryArtifact.data as any;
                              const type = env.primaryArtifact.type;
                              return (
                                <div key={env.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  <div className="thinking-section-label">
                                    Task: {env.skill} / {type.toLowerCase().replace(/_/g, ' ')}
                                  </div>

                                  {/* Schema details */}
                                  {type === 'SCHEMA_VIEW' && d && (
                                    <div className="thinking-step" style={{ flexDirection: 'column', gap: 2 }}>
                                      {d.scope === 'DATASET' && d.dataset && (
                                        <div>Dataset: <strong>{d.dataset}</strong> ({d.columns?.length || 0} tables)</div>
                                      )}
                                      {d.scope === 'TABLE' && (
                                        <>
                                          <div>Table: <strong>{d.dataset ? `${d.dataset}.` : ''}{d.table}</strong></div>
                                          {d.columns?.length > 0 && (
                                            <div>Fields: {d.columns.map((c: any) => `${c.name} (${c.type})`).slice(0, 8).join(', ')}{d.columns.length > 8 ? ` +${d.columns.length - 8} more` : ''}</div>
                                          )}
                                          {d.rowCount != null && <div>Row count: {Number(d.rowCount).toLocaleString()}</div>}
                                          {d.partitioning && <div>Partitioned by: {d.partitioning.field} ({d.partitioning.type})</div>}
                                          {d.clustering?.length > 0 && <div>Clustered by: {d.clustering.join(', ')}</div>}
                                        </>
                                      )}
                                      {d.scope === 'PROJECT' && <div>Project: {d.project}</div>}
                                    </div>
                                  )}

                                  {/* Query/Table details */}
                                  {(type === 'TABLE' || type.includes('CHART') || type === 'SCATTER' || type === 'HISTOGRAM' || type === 'HEATMAP' || type === 'KPI_CARD') && d && (
                                    <div className="thinking-step" style={{ flexDirection: 'column', gap: 2 }}>
                                      {d.columns?.length > 0 && (
                                        <div>Columns: {d.columns.slice(0, 10).join(', ')}{d.columns.length > 10 ? ` +${d.columns.length - 10} more` : ''}</div>
                                      )}
                                      {d.rows?.length !== undefined && <div>Rows returned: {d.rows.length}</div>}
                                      {d.totalBytesProcessed > 0 && <div>Data scanned: {formatBytesCompact(d.totalBytesProcessed)}</div>}
                                    </div>
                                  )}

                                  {/* Data quality details */}
                                  {type === 'DATA_QUALITY_VIEW' && d && (
                                    <div className="thinking-step" style={{ flexDirection: 'column', gap: 2 }}>
                                      <div>Table checked: <strong>{d.table}</strong></div>
                                      <div>Check type: {d.checkType}</div>
                                      {d.summary && <div>Rows scanned: {d.summary.rowsScanned?.toLocaleString()}, Issues: {d.summary.issuesFound}</div>}
                                    </div>
                                  )}

                                  {/* Data management details */}
                                  {(type === 'CONFIRMATION_CARD' || type === 'COMPLETION_CARD') && d && (
                                    <div className="thinking-step" style={{ flexDirection: 'column', gap: 2 }}>
                                      {d.operation && <div>Operation: {d.operation}</div>}
                                      {d.affectedRowCount != null && <div>Rows affected: {d.affectedRowCount.toLocaleString()}</div>}
                                      {d.rowsAffected != null && <div>Rows affected: {d.rowsAffected.toLocaleString()}</div>}
                                    </div>
                                  )}


                                  {/* Cost */}
                                  {env.provenance.cost && (
                                    <div className="thinking-meta">
                                      <span>{formatBytesCompact(env.provenance.cost.totalBytesProcessed)} processed</span>
                                      <span>Tier {env.provenance.cost.tier}</span>
                                      {env.provenance.freshness && <span>{env.provenance.freshness}</span>}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      )}

                      {/* Error card in sidebar */}
                      {!msg.envelopes && !msg.content && lastError && i === messages.length - 1 && renderErrorCard()}
                    </div>
                  )}
                </div>
              ))}
              {loading && rerunningIdx === null && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                }}>
                  <SparkSpinner size={20} />
                  <span style={{
                    fontSize: 12,
                    fontStyle: 'italic',
                    color: 'var(--text-muted)',
                    fontFamily: "'Google Sans', 'Inter', sans-serif",
                  }}>
                    {statusText || 'Processing...'}
                  </span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input bar docked at bottom of sidebar */}
            <div className="chat-sidebar-input">
              <div className="chat-sidebar-input-inner mystic-prompt-container" style={{
                borderRadius: contextItems.length > 0 ? 16 : undefined,
                padding: contextItems.length > 0 ? '8px 10px 10px 14px' : undefined,
                display: contextItems.length > 0 ? 'flex' : undefined,
                flexDirection: contextItems.length > 0 ? 'column' as const : undefined,
                gap: contextItems.length > 0 ? 6 : undefined,
              }}>
                {contextChipsRow}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, width: '100%' }}>
                  {inputTextarea(activeProject ? 'Ask about your data...' : 'Select a project first...')}
                  {sendButton}
                </div>
              </div>
            </div>
          </div>

          {/* -- Drag handle -- */}
          <div
            className={`layout-drag-handle${isDragging ? ' layout-drag-handle--active' : ''}`}
            onMouseDown={handleDragStart}
          />

          {/* -- Results panel -- */}
          <div className="results-panel" ref={resultsPanelRef}>
            {!hasChat ? (
              <div className="results-panel-empty">
                <CrystalBallOracle ballSize={88} />
                <h1 style={{ fontSize: 22, fontWeight: 500, color: 'var(--text)', margin: '20px 0 6px', letterSpacing: '-0.2px' }}>
                  BigQuery AIF
                </h1>
                <p style={{ color: 'var(--text-muted)', margin: '0 0 16px', fontSize: 14 }}>
                  Ask anything about your data
                </p>
                {!activeProject && (
                  <div style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: '14px 20px',
                    maxWidth: 480,
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text-muted)',
                    fontSize: 13,
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#f59e0b' }}>info</span>
                    Select a GCP project from the sidebar to get started.
                  </div>
                )}
                {activeProject && recentItems.length > 0 && (
                  <div className="recent-items-section" style={{ maxWidth: 480 }}>
                    <div className="recent-items-label">Recent</div>
                    <div className="recent-items">
                      {recentItems.map((item, idx) => (
                        <button
                          key={`${item.type}-${item.name}-${idx}`}
                          className="recent-item-chip"
                          onClick={() => {
                            if (item.type === 'table' && item.dataset) {
                              sendMessage(`Show me the schema for ${item.dataset}.${item.name}`);
                            } else if (item.type === 'table') {
                              sendMessage(`Show me the schema for ${item.name}`);
                            } else {
                              sendMessage(`What tables are in the ${item.name} dataset?`);
                            }
                          }}
                        >
                          <span className="material-symbols-outlined">
                            {item.type === 'table' ? 'table_chart' : 'dataset'}
                          </span>
                          {item.name}
                          {item.type === 'table' && item.dataset && (
                            <span className="recent-item-chip-sub">{item.dataset}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : allEnvelopes.length > 0 ? (
              <div className="results-panel-inner">
                {allEnvelopes.map((env) => (
                  <div key={env.id} data-envelope-id={env.id}>
                    <ArtifactCard
                      envelope={env}
                      onConfirm={() => handleConfirm(env)}
                      onCancel={() => handleCancel(env)}
                      onChipClick={handleChipClick}
                      onInlineClick={handleInlineClick}
                      onPin={extractContextItems(env).length > 0 ? pinEnvelopeContext : undefined}
                      isPinned={pinnedEnvelopeId === env.id}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="results-panel-empty">
                <EmptyCanvasAnimation />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function formatBytesCompact(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
