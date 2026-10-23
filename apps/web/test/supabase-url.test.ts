import { describe, expect, it } from 'vitest';

import { supabaseBaseUrl } from '../lib/supabase';

/**
 * Sign-up failed with "Invalid path specified in request URL" when
 * NEXT_PUBLIC_SUPABASE_URL held the REST URL that `supabase status` prints
 * (`…/rest/v1`): the client appends `/auth/v1/signup` to it. The client is
 * handed the project URL whatever was pasted.
 */

describe('supabaseBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['http://127.0.0.1:54321/', 'http://127.0.0.1:54321'],
    ['http://127.0.0.1:54321/rest/v1', 'http://127.0.0.1:54321'],
    ['http://127.0.0.1:54321/rest/v1/', 'http://127.0.0.1:54321'],
    ['https://abc.supabase.co/auth/v1', 'https://abc.supabase.co'],
    ['  https://abc.supabase.co  ', 'https://abc.supabase.co'],
    // The dashboard's "RESTful endpoint", which production was built with.
    ['https://abc.supabase.co/rest/v1/', 'https://abc.supabase.co'],
    ['https://abc.supabase.co/graphql/v1', 'https://abc.supabase.co'],
    ['http://127.0.0.1:54321/storage/v1/s3', 'http://127.0.0.1:54321'],
    ['https://abc.supabase.co/auth/v1/signup', 'https://abc.supabase.co'],
  ])('%s -> %s', (raw, want) => {
    expect(supabaseBaseUrl(raw)).toBe(want);
  });

  it('leaves an unset URL unset, so the app still says Supabase is not configured', () => {
    expect(supabaseBaseUrl(undefined)).toBeUndefined();
    expect(supabaseBaseUrl('  ')).toBeUndefined();
  });
});
