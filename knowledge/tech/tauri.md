---
type: TechCard
id: tauri
title: Tauri 2
description: A toolkit for small desktop apps whose UI is a web page in the system webview and whose core is Rust.
aliases: [tauri, tauri 2, tauri v2]
layers: [ui-toolkit, app-architecture, ipc, os-integration, packaging, updates, testing]
pin: "2"
pinnedOn: 2026-10-23
docs: https://v2.tauri.app/start/
pros:
  - Small installers, because it uses the webview the OS already has
  - Commands and capabilities make the IPC surface explicit
  - One bundler builds installers for Windows, macOS and Linux
cons:
  - The core is Rust, which is a second language for a web developer
  - Webviews differ between operating systems, so the UI needs testing on each
install:
  linux: Install Rust with rustup, the webkit2gtk and build packages, then npm create tauri-app@latest
  macos: Install Rust with rustup and the Xcode command line tools, then npm create tauri-app@latest
  windows: Install Rust with rustup and the Microsoft C++ build tools (WebView2 ships with Windows 11), then npm create tauri-app@latest
status: draft
---

Tauri apps have two halves: the webview that draws the UI and a Rust process
that owns the window, the file system and everything privileged. The UI calls
the core through declared commands, and capabilities say which commands each
window may call. That boundary is the app's IPC contract.

Draft card from phase 2. Review the pin and install lines before relying on it.
