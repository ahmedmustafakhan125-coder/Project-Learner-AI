---
type: TechCard
id: rust
title: Rust
description: A compiled systems language whose ownership rules catch memory errors at compile time.
aliases: [rust, rustlang, cargo]
layers: [kernel-language, app-architecture, language, host-language, core-logic, runtime]
pin: "1"
pinnedOn: 2026-10-23
docs: https://doc.rust-lang.org/book/
pros:
  - Memory safety without a garbage collector
  - Cargo builds, tests and fetches dependencies with one tool
  - Runs bare metal with no_std, so it can write a kernel
cons:
  - The borrow checker takes weeks to feel natural
  - Compile times are longer than C or Go
install:
  linux: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  macos: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  windows: winget install Rustlang.Rustup
status: draft
---

Rust is installed and updated with rustup, and every project is built with
Cargo. A kernel in Rust uses `#![no_std]` and a custom target, so the standard
library is not available and allocation is set up by hand.

Draft card from phase 2. Review the pin and install lines before relying on it.
