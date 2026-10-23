---
type: TechCard
id: lox
title: Lox (Crafting Interpreters)
description: A small dynamic teaching language from the free book Crafting Interpreters, built twice there, as a tree-walker and as a bytecode VM.
aliases: [lox, crafting interpreters, jlox, clox]
layers: [lexer, parser, ast, semantic-analysis, ir, optimiser, backend, runtime-gc, driver, repl, error-reporting, test-corpus]
pin: null
pinnedOn: 2026-10-23
docs: https://craftinginterpreters.com/contents.html
pros:
  - Small enough to finish, large enough to have closures and classes
  - The book explains every stage, from scanning to garbage collection
  - Its grammar is fixed, so a test corpus can be written from step 1
cons:
  - The book's code is Java and C; another implementation language means translating, not copying
  - Dynamic typing leaves type checking out
install: {}
status: draft
---

The book's first half builds a tree-walking interpreter (jlox), its second a
bytecode VM with a garbage collector (clox). Steps link to its chapters and
paraphrase them; the book's text is never copied into a step.

Draft card from phase 2. Review before relying on it.
