---
type: TechCard
id: sqlite
title: SQLite
description: A SQL database stored in a single file, embedded in the program rather than run as a server.
aliases: [sqlite, sqlite3]
layers: [local-storage, database, storage, persistence]
pin: "3"
pinnedOn: 2026-10-23
docs: https://www.sqlite.org/docs.html
pros:
  - No server to install or run; the database is one file
  - Full SQL with transactions
  - Bindings exist in almost every language, including Python's standard library
cons:
  - One writer at a time, so it does not suit many concurrent users
  - Schema changes need care because ALTER TABLE is limited
install:
  linux: sudo apt install sqlite3
  macos: brew install sqlite
  windows: winget install SQLite.SQLite
status: draft
---

SQLite is a library, not a service: the app opens a file and runs SQL against
it. Desktop and mobile apps keep it in the platform's app-data directory.

Draft card from phase 2. Review the pin and install lines before relying on it.
