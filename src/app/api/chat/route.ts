// src/app/api/chat/route.ts
// Thin API route for the test harness. Accepts the same payload as the old
// server-side route and delegates to ChatOrchestrator.processMessage().
// This file exists solely to support scripts/test-loop.mjs.

import { NextRequest, NextResponse } from 'next/server';
import { setAccessToken } from '@/lib/gis-auth';
import { ChatOrchestrator } from '@/lib/chat-orchestrator';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, history = [], accessToken, context = {} } = body;

    if (!message) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }

    // Inject the access token so BigQuery calls can use it
    if (accessToken) {
      setAccessToken(accessToken);
    }

    const result = await ChatOrchestrator.processMessage({
      message,
      history,
      context,
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/chat]', msg);
    return NextResponse.json({ error: msg, envelopes: [] }, { status: 500 });
  }
}
