---
type: TechCard
id: python
title: Python 3
description: An interpreted language with a large standard library, readable syntax and no build step.
aliases: [python, python 3, python3, cpython]
layers: [host-language, language, runtime, processing]
pin: "3"
pinnedOn: 2026-10-23
docs: https://docs.python.org/3/
pros:
  - No compile step, so every change runs at once
  - The standard library covers files, text, JSON, SQLite and tests
  - Runs in the browser sandbox through Pyodide when it uses only the standard library
cons:
  - Much slower than compiled languages for tight loops
  - Types are checked only by optional tools
install:
  linux: sudo apt install python3
  macos: brew install python
  windows: winget install Python.Python.3.12
status: draft
---

A project in stdlib Python needs nothing but the interpreter, which is why the
browser sandbox can run and check it. `unittest` ships with Python, so tests
need no dependency either.

Draft card from phase 2. Review the pin and install lines before relying on it.
