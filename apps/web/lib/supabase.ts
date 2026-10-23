'use client';

import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client.
 *
 * This uses the ANON key, which is safe to ship: every table has Row Level
 * Security, so the key alone grants access to nothing. The service-role key
 * bypasses RLS and must never appear in this bundle.
 */
/**
 * The project URL the client wants, from whatever was configured.
 *
 * `supabase status` prints the REST URL (`…/rest/v1`) right beside the API
 * URL, and pasting it here broke sign-in and sign-up with "Invalid path
 * specified in request URL": the client appends `/auth/v1/…` to whatever it
 * is given. A service suffix and trailing slashes are dropped, so only the
 * project URL reaches the client.
 */
export function supabaseBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '').replace(/\/(rest|auth|storage|realtime|functions)\/v1$/i, '');
}

const url = supabaseBaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null;

export async function currentToken(): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  return token;
}
