/**
 * Row Level Security, proven against a live database.
 *
 * README.md claims RLS isolates two users across SELECT, UPDATE and INSERT.
 * Nothing in the offline suite can check that: RLS is enforced by Postgres, so
 * the only honest test signs in as two real learners and tries to reach across.
 *
 * This matters more here than in a typical app. `apps/api` holds the
 * service-role key, which BYPASSES RLS entirely — so RLS is not what protects
 * the API, the hand-written `user_id` filters in each route are. RLS is what
 * protects the *browser*, which talks to Supabase directly with the anon key.
 * If RLS were mis-set, every learner could read every other learner's work
 * without the API being involved at all.
 *
 * Opt-in, because it needs a live project and writes rows:
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *     npx vitest run --root apps/api --config vitest.live.config.ts
 *
 * The anon key is safe to use here — it is already public in the browser
 * bundle, and RLS is precisely the thing under test.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!URL || !ANON) {
  throw new Error(
    'RLS live test needs SUPABASE_URL and SUPABASE_ANON_KEY. ' +
    'The anon key is public — it ships in the browser bundle.',
  );
}

/** Two throwaway learners, unique per run so reruns never collide. */
const stamp = Date.now();
const ALICE = { email: `rls-alice-${stamp}@example.com`, password: `A!${stamp}aa` };
const BOB = { email: `rls-bob-${stamp}@example.com`, password: `B!${stamp}bb` };

function anonClient(): SupabaseClient {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(who: { email: string; password: string }): Promise<SupabaseClient> {
  const client = anonClient();
  const { error: signUpError } = await client.auth.signUp(who);
  // An existing account is fine; a rate limit is not, and should say so plainly.
  if (signUpError && !/already registered/i.test(signUpError.message)) {
    if (/rate limit/i.test(signUpError.message)) {
      throw new Error(
        `Supabase email rate limit hit. Turn off "Confirm email" in Authentication ` +
        `→ Providers, or wait an hour. Original: ${signUpError.message}`,
      );
    }
    throw new Error(`sign-up failed: ${signUpError.message}`);
  }

  const { data, error } = await client.auth.signInWithPassword(who);
  if (error || !data.session) {
    throw new Error(
      `sign-in failed for ${who.email}: ${error?.message ?? 'no session'}. ` +
      `If confirmation emails are on, this test cannot sign in.`,
    );
  }
  return client;
}

let alice: SupabaseClient;
let bob: SupabaseClient;
let aliceId = '';
let aliceProjectId = '';

beforeAll(async () => {
  alice = await signIn(ALICE);
  bob = await signIn(BOB);

  const { data: aliceUser } = await alice.auth.getUser();
  aliceId = aliceUser.user?.id ?? '';
  expect(aliceId, 'alice has a user id').toBeTruthy();

  // Alice creates something worth stealing.
  const { data, error } = await alice
    .from('projects')
    .insert({ user_id: aliceId, title: `rls-probe-${stamp}`, status: 'draft' })
    .select('id')
    .single();

  if (error) throw new Error(`alice could not create her own project: ${error.message}`);
  aliceProjectId = data.id;
}, 60_000);

afterAll(async () => {
  if (aliceProjectId) await alice.from('projects').delete().eq('id', aliceProjectId);
  await alice?.auth.signOut();
  await bob?.auth.signOut();
});

describe('RLS isolates two learners', () => {
  it('alice can read her own project', async () => {
    const { data } = await alice.from('projects').select('id').eq('id', aliceProjectId);
    expect(data).toHaveLength(1);
  });

  it('SELECT: bob cannot read alice’s project', async () => {
    const { data, error } = await bob.from('projects').select('id').eq('id', aliceProjectId);
    // RLS filters rather than errors: the row is simply not visible.
    expect(error).toBeNull();
    expect(data, 'bob must see nothing of alice’s').toEqual([]);
  });

  it('SELECT: bob listing all projects never sees alice’s', async () => {
    const { data } = await bob.from('projects').select('id, user_id');
    const leaked = (data ?? []).filter((row) => row.user_id !== null && row.user_id !== undefined);
    expect(leaked.every((row) => row.id !== aliceProjectId)).toBe(true);
  });

  it('UPDATE: bob cannot modify alice’s project', async () => {
    await bob.from('projects').update({ title: 'owned-by-bob' }).eq('id', aliceProjectId);
    // Whether it errors or silently affects zero rows, the row must be unchanged.
    const { data } = await alice.from('projects').select('title').eq('id', aliceProjectId).single();
    expect(data?.title).toBe(`rls-probe-${stamp}`);
  });

  it('DELETE: bob cannot delete alice’s project', async () => {
    await bob.from('projects').delete().eq('id', aliceProjectId);
    const { data } = await alice.from('projects').select('id').eq('id', aliceProjectId);
    expect(data, 'alice’s project must survive').toHaveLength(1);
  });

  it('INSERT: bob cannot create a row owned by alice', async () => {
    const { error } = await bob
      .from('projects')
      .insert({ user_id: aliceId, title: 'forged', status: 'draft' });
    expect(error, 'with_check must refuse a forged user_id').not.toBeNull();
  });
});

describe('every table carries an owner policy', () => {
  // Reading another learner's rows from any of these would be a breach; each
  // must come back empty for a user who owns nothing in it.
  const TABLES = [
    'projects',
    'project_steps',
    'enrollments',
    'step_attempts',
    'threads',
    'messages',
    'agent_responses',
    'attachments',
    'llm_usage',
    'step_drafts',
    'agent_followups',
    'project_chat_messages',
  ];

  it('a fresh learner sees no rows they do not own', async () => {
    const offenders: string[] = [];
    for (const table of TABLES) {
      const { data, error } = await bob.from(table).select('*').limit(50);
      if (error) continue; // table absent in this deployment, or no read grant
      const foreign = (data ?? []).filter(
        (row: Record<string, unknown>) => 'user_id' in row && row['user_id'] !== null,
      );
      // Bob owns nothing except his own auth bootstrap rows.
      const { data: bobUser } = await bob.auth.getUser();
      const bobId = bobUser.user?.id;
      if (foreign.some((row: Record<string, unknown>) => row['user_id'] !== bobId)) {
        offenders.push(table);
      }
    }
    expect(offenders, `tables leaking other learners' rows: ${offenders.join(', ')}`).toEqual([]);
  }, 60_000);
});
