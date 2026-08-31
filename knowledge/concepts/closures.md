---
type: Concept
title: Closures
description: A function keeps access to the scope it was defined in, not the scope it is called from.
tags: [javascript, typescript, python, closures, scope, functions]
status: stable
generated: { by: human:ahmed, at: 2026-08-31T00:00:00Z }
---

A closure is a function bundled with the variables that were in scope where it
was **defined**. Not where it is called from — that distinction is the whole
idea, and it is where most confusion starts.

```js
function counter() {
  let n = 0;              // lives on after counter() returns
  return () => ++n;       // the returned function still sees n
}
const next = counter();
next(); // 1
next(); // 2
```

`n` survives because the returned function still refers to it. Each call to
`counter()` makes a fresh `n`, so two counters never interfere.

## Where it bites

The classic bug is capturing a loop variable that changes underneath you. `var`
is function-scoped, so every closure shares one binding; `let` is block-scoped,
so each iteration gets its own.

```js
for (var i = 0; i < 3; i++) setTimeout(() => console.log(i));  // 3 3 3
for (let i = 0; i < 3; i++) setTimeout(() => console.log(i));  // 0 1 2
```

Python has the same trap with late binding in lambdas, solved with a default
argument (`lambda i=i: i`) rather than a different declaration keyword.

See also [explaining tradeoffs](/pedagogy/explaining-tradeoffs.md) when a
learner asks whether closures are "better" than classes — they are not
competitors.
