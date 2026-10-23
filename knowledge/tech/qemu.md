---
type: TechCard
id: qemu
title: QEMU
description: A machine emulator that boots a kernel image headless, with a serial port on stdio and a GDB stub.
aliases: [qemu, qemu-system-x86_64, qemu-system-riscv64]
layers: [emulator, debugger]
pin: null
pinnedOn: 2026-10-23
docs: https://www.qemu.org/docs/master/
pros:
  - Boots a kernel in seconds with no hardware
  - "-serial stdio and -display none make tests scriptable"
  - "-s -S waits for GDB, so a kernel can be stepped from its first instruction"
cons:
  - Emulated devices are kinder than real hardware, so some bugs show only on a real machine
  - Its many options take time to learn
install:
  linux: sudo apt install qemu-system-x86
  macos: brew install qemu
  windows: Inside WSL 2, sudo apt install qemu-system-x86
status: draft
---

Kernel tests boot under QEMU with the `isa-debug-exit` device on x86, so the
kernel can end the run with a status code the harness reads.

Draft card from phase 2. Review the pin and install lines before relying on it.
