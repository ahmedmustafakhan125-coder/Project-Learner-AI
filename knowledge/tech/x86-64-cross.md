---
type: TechCard
id: x86-64-cross
title: x86-64 cross toolchain
description: A compiler, assembler and linker that build freestanding code for x86_64-elf instead of the host operating system.
aliases: [x86_64-elf-gcc, x86-64 cross compiler, cross compiler, binutils, nasm]
layers: [toolchain, build-system]
pin: null
pinnedOn: 2026-10-23
docs: https://wiki.osdev.org/GCC_Cross-Compiler
pros:
  - Builds code that does not assume the host's libraries or ABI
  - The OSDev wiki documents every step of building it
cons:
  - Building GCC from source takes time
  - Easy to call the host compiler by mistake
install:
  linux: Build x86_64-elf binutils and GCC as the OSDev wiki describes, or use clang with --target=x86_64-elf
  macos: brew install x86_64-elf-gcc
  windows: Inside WSL 2, build x86_64-elf binutils and GCC, or use clang with --target=x86_64-elf
status: draft
---

A kernel is built with a cross-compiler and a linker script, usually from a
Makefile, into an ELF that the bootloader loads.

Draft card from phase 2. Review the install lines before relying on it.
