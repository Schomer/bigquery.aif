// src/lib/firestore-service.ts
// Client-side Firestore operations using Firebase client SDK directly.

import { doc, getDoc, setDoc, deleteField, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { ChatMessage, CompositionEnvelope } from './types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  messages: ChatMessage[];
}

export interface FavoriteItem {
  id: string;
  createdAt: string;
  label: string;
  type: 'message' | 'query' | 'table' | 'chart';
  envelope?: CompositionEnvelope;
  tableRef?: string;
}

export interface SavedPrompt {
  id: string;
  createdAt: string;
  label: string;
  prompt: string;
  category: 'Reporting' | 'Data Quality' | 'Schema' | 'Cost' | 'Other';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function userDoc(uid: string) {
  return doc(db, 'users', uid);
}

async function getUserData(uid: string): Promise<any> {
  const snap = await getDoc(userDoc(uid));
  return snap.exists() ? snap.data() : {};
}

// ── Conversations ────────────────────────────────────────────────────────────

export async function getConversations(uid: string): Promise<SavedConversation[]> {
  const state = await getUserData(uid);
  const convMap = state.conversations || {};
  const conversations: SavedConversation[] = Object.entries(convMap).map(([id, data]: [string, any]) => {
    const messages: ChatMessage[] = data.messagesJson
      ? (JSON.parse(data.messagesJson) as ChatMessage[])
      : (data.messages ?? []);
    return { ...data, id, messages };
  });
  return conversations.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function saveConversation(uid: string, conv: SavedConversation): Promise<void> {
  const { messages, ...rest } = conv;
  const persisted = {
    ...rest,
    messagesJson: JSON.stringify(messages),
  };
  await setDoc(userDoc(uid), {
    conversations: { [conv.id]: persisted },
  }, { merge: true });
}

export async function deleteConversation(uid: string, id: string): Promise<void> {
  await updateDoc(userDoc(uid), {
    [`conversations.${id}`]: deleteField(),
  });
}

// ── Favorites ────────────────────────────────────────────────────────────────

export async function getFavorites(uid: string): Promise<FavoriteItem[]> {
  const state = await getUserData(uid);
  const favMap = state.favorites || {};
  const favorites: FavoriteItem[] = Object.entries(favMap).map(([id, data]: [string, any]) => {
    const envelope = data.envelopeJson
      ? (JSON.parse(data.envelopeJson) as CompositionEnvelope)
      : data.envelope;
    return { ...data, id, envelope };
  });
  return favorites.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function addFavorite(uid: string, item: FavoriteItem): Promise<void> {
  const { envelope, ...rest } = item;
  const persisted = {
    ...rest,
    envelopeJson: envelope ? JSON.stringify(envelope) : null,
  };
  await setDoc(userDoc(uid), {
    favorites: { [item.id]: persisted },
  }, { merge: true });
}

export async function removeFavorite(uid: string, id: string): Promise<void> {
  await updateDoc(userDoc(uid), {
    [`favorites.${id}`]: deleteField(),
  });
}

// ── Saved Prompts ────────────────────────────────────────────────────────────

export async function getPrompts(uid: string): Promise<SavedPrompt[]> {
  const state = await getUserData(uid);
  const promptMap = state.prompts || {};
  const prompts: SavedPrompt[] = Object.entries(promptMap).map(([id, data]: [string, any]) => {
    return { ...data, id };
  });
  return prompts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function savePrompt(uid: string, prompt: SavedPrompt): Promise<void> {
  await setDoc(userDoc(uid), {
    prompts: { [prompt.id]: prompt },
  }, { merge: true });
}

export async function deletePrompt(uid: string, id: string): Promise<void> {
  await updateDoc(userDoc(uid), {
    [`prompts.${id}`]: deleteField(),
  });
}

// ── User Preferences ─────────────────────────────────────────────────────────

export interface UserPreferences {
  activeProject?: string;
}

export async function getUserPreferences(uid: string): Promise<UserPreferences> {
  try {
    const state = await getUserData(uid);
    return state.preferences || {};
  } catch (err) {
    console.warn('[getUserPreferences]', err);
    return {};
  }
}

export async function saveUserPreferences(uid: string, prefs: Partial<UserPreferences>): Promise<void> {
  try {
    await setDoc(userDoc(uid), { preferences: prefs }, { merge: true });
  } catch (err) {
    console.warn('[saveUserPreferences]', err);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function autoTitle(firstMessage: string): string {
  return firstMessage.length > 52
    ? firstMessage.slice(0, 50).trim() + '...'
    : firstMessage.trim();
}
