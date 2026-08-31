---
type: Concept
title: Content Security Policy
description: What a CSP actually constrains, plus the iframe inheritance rule that surprises people.
tags: [web, security, csp, browser, iframe, sandbox, javascript]
status: stable
generated: { by: human:ahmed, at: 2026-08-31T00:00:00Z }
---

A CSP is a response header telling the browser which sources a document may load
and execute. It is a defence-in-depth layer: it does not fix an injection, it
limits what one can do.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'
```

## Inheritance is the part that surprises people

A framed document normally gets its **own** policy from its own response
headers. But frames created from *local schemes* — `srcdoc`, `about:blank`,
`blob:`, `data:` — have no response of their own, so they **inherit the parent's
policy**.

That means an inline `<script>` inside a `srcdoc` iframe is governed by the
parent's `script-src`. If the parent has no `'unsafe-inline'`, the frame's own
bootstrap script is refused and the frame silently does nothing at all. Serving
the same HTML from a real URL instead gives it a policy you control separately.

## `'self'` is meaningless in an opaque origin

An iframe with `sandbox="allow-scripts"` and no `allow-same-origin` gets an
**opaque origin**. `'self'` resolves against that origin, so it matches nothing —
not even the server that just delivered the frame. Such a policy must name the
origin explicitly.

## What the sandbox attribute does and does not do

- It **does** block reaching the parent's DOM, cookies, and storage.
- It does **not** block `fetch`. An opaque-origin document can still make
  requests; they simply carry `Origin: null`, and anything replying
  `Access-Control-Allow-Origin: *` is readable.

Network containment comes from `connect-src`, not from the sandbox attribute.
Confusing the two produces code that looks contained and is not — see
[row level security](/concepts/row-level-security.md) for the same shape of
mistake one layer down.
