'use client';

import { ApiClient } from '@ai-edu/api-client';
import { currentToken } from './supabase';

/**
 * The single API client for the app. Nothing in the UI calls `fetch` directly —
 * that rule is what lets the future mobile app reuse this entire layer.
 *
 * The token is fetched per request rather than captured once, so a session
 * refreshed in the background is picked up without rebuilding the client.
 */
export const api = new ApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  getToken: currentToken,
});
