---
type: TechCard
id: limine
title: Limine
description: A bootloader with its own boot protocol that loads a 64-bit kernel in long mode with a framebuffer and a memory map.
aliases: [limine, limine boot protocol]
layers: [boot-protocol]
pin: null
pinnedOn: 2026-10-23
docs: https://github.com/limine-bootloader/limine/blob/trunk/PROTOCOL.md
pros:
  - Hands the kernel a 64-bit environment, skipping real-mode setup
  - Requests in the kernel binary ask for a framebuffer, memory map and more
  - Boots on BIOS and UEFI
cons:
  - Hides the boot process a learner might want to see
  - Its protocol is its own, not Multiboot2
install: {}
status: draft
---

A Limine kernel declares requests in a dedicated section of its ELF file, and
the bootloader fills in the responses before jumping to the entry point.

Draft card from phase 2. Review the pin and the docs link before relying on it.
