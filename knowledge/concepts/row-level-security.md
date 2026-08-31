---
type: Concept
title: Row Level Security
description: Postgres authorisation that lives in the database, and the permissive-vs-restrictive rule people get wrong.
tags: [postgres, sql, supabase, rls, security, authorisation, database]
status: stable
generated: { by: human:ahmed, at: 2026-08-31T00:00:00Z }
---

Row Level Security moves "which rows may this user see" out of application code
and into the database, so a forgotten `WHERE` clause in one query cannot leak
another user's data.

```sql
alter table notes enable row level security;
alter table notes force row level security;

create policy notes_owner on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

`using` filters what can be read; `with check` constrains what can be written.
`force` matters: without it the table's owner bypasses RLS entirely.

## The rule almost everyone gets wrong

Policies come in two kinds, and they combine differently:

- **PERMISSIVE** (the default) policies are combined with **OR**.
- **RESTRICTIVE** policies are combined with **AND**.

So adding a second permissive policy can only ever *widen* access. Writing a
narrower permissive policy to tighten an existing one does nothing at all — the
broader policy still grants the row, and no error is raised.

```sql
-- Tightens nothing: ORed with the existing owner policy.
create policy tighter on notes for insert with check (user_id = auth.uid() and verified);

-- Actually tightens: ANDed with it.
create policy tighter on notes as restrictive
  for insert with check (verified);
```

A restrictive policy grants nothing by itself. It only subtracts, so a table
needs at least one permissive policy for anything to be allowed at all.
