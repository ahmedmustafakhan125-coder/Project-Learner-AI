---
type: Concept
title: Prompt caching
description: Why a cached prefix must be byte-identical, and why breaking it produces no error.
tags: [llm, anthropic, claude, caching, prompt, cost, performance]
status: stable
generated: { by: human:ahmed, at: 2026-08-31T00:00:00Z }
---

Prompt caching lets a provider skip reprocessing a prefix it has already seen.
The match is a **prefix match over exact bytes**, which has one consequence that
dominates everything else: a single changed character anywhere in the prefix
invalidates the whole thing.

## The failure mode is silence

Nothing errors. No status code changes. No test goes red. The response is
identical. The only symptom is the bill.

That is what makes an interpolated timestamp, a user id, or a `Date.now()` in a
shared prefix such an expensive mistake — it is invisible in every way a bug is
normally noticed.

```ts
// Poisons the cache for every request, forever.
const system = `You are a tutor. Session started ${Date.now()}.`;
```

Anything that varies per request belongs *after* the cache boundary, never
inside the prefix.

## Ordering matters too

A cache entry only becomes readable once the request that writes it is already
in flight. Firing several requests that share a prefix simultaneously means none
of them can read what the others are still writing, and every one pays full
price. Sending one first, waiting for its first token, then releasing the rest is
what turns a shared prefix into an actual saving.

Deterministic rendering is therefore a cost property, not a tidiness one. Any
code that builds a shared prefix — iterating an object's keys, sorting a list,
formatting a number — has to produce the same bytes every time.
