import type { Profile } from './types.js';

/**
 * Hobby kernels (docs/project-learner.md §6, "Operating systems").
 *
 * Verified by booting headless in QEMU and reading the serial port, so every
 * OS project has a test mode from milestone 1. Nothing here runs in the
 * browser sandbox.
 */

const KERNEL_CORE = [
  'toolchain',
  'boot-protocol',
  'kernel-language',
  'drivers',
  'emulator',
  'debugger',
  'build-system',
];

export const systemsOs: Profile = {
  id: 'systems-os',
  label: 'Operating system',
  deep: true,
  signalWords: [
    'operating system',
    'kernel',
    'bootloader',
    'boot loader',
    'os',
    'bare metal',
    'hobby os',
    'osdev',
    'multiboot',
    'limine',
    'grub',
    'uefi',
    'interrupts',
    'paging',
    'xv6',
  ],
  layers: [
    {
      id: 'toolchain',
      label: 'Cross toolchain',
      section: 'Toolchain',
      description: 'The compiler, assembler and linker that build code for the target, not the host.',
      research: 'x86-64-cross',
    },
    {
      id: 'build-system',
      label: 'Build system',
      section: 'Toolchain',
      description: 'How the kernel and its bootable image are built: Make, CMake or cargo.',
      research: 'x86-64-cross',
    },
    {
      id: 'boot-protocol',
      label: 'Boot protocol',
      section: 'Boot',
      description: 'How the machine hands control to the kernel: Limine, Multiboot2 with GRUB, UEFI or an own loader.',
      research: 'limine',
    },
    {
      id: 'kernel-language',
      label: 'Kernel language',
      section: 'Kernel',
      description: 'The language the kernel is written in, freestanding, with no standard library.',
      research: 'c',
    },
    {
      id: 'memory-management',
      label: 'Memory management',
      section: 'Kernel',
      description: 'The physical frame allocator, paging and the kernel heap.',
      research: 'osdev-core',
    },
    {
      id: 'interrupts',
      label: 'Interrupts',
      section: 'Kernel',
      description: 'Descriptor tables and interrupt handlers: the GDT and IDT on x86, trap vectors on RISC-V.',
      research: 'osdev-core',
    },
    {
      id: 'scheduler',
      label: 'Scheduler',
      section: 'Kernel',
      description: 'Kernel threads, context switching and the timer that drives them.',
      research: 'osdev-core',
    },
    {
      id: 'syscalls',
      label: 'Syscalls and userspace',
      section: 'Kernel',
      description: 'The boundary between user programs and the kernel.',
      research: 'osdev-core',
    },
    {
      id: 'filesystem',
      label: 'Filesystem',
      section: 'Kernel',
      description: 'How files are laid out on a disk image and read back.',
      research: 'osdev-core',
    },
    {
      id: 'drivers',
      label: 'Drivers',
      section: 'Devices',
      description: 'Serial, framebuffer, keyboard and timer drivers. Serial comes first: tests read it.',
      research: 'osdev-core',
    },
    {
      id: 'emulator',
      label: 'Emulator',
      section: 'Tools',
      description: 'The machine the kernel boots in during development and tests: QEMU.',
      research: 'qemu',
    },
    {
      id: 'debugger',
      label: 'Debugger',
      section: 'Tools',
      description: 'GDB attached to QEMU, for stepping through a kernel that does not print yet.',
      research: 'qemu',
    },
  ],
  // The floor is T4, so T1 to T3 are never planned; they repeat T4's core.
  requiredLayersByTier: {
    T1: KERNEL_CORE,
    T2: KERNEL_CORE,
    T3: KERNEL_CORE,
    T4: [...KERNEL_CORE, 'interrupts'],
    T5: [...KERNEL_CORE, 'interrupts', 'memory-management', 'scheduler'],
  },
  slots: [
    {
      key: 'target_arch',
      label: 'Target architecture',
      description: 'The CPU the kernel runs on: x86-64, RISC-V or AArch64.',
      weight: 2,
      required: true,
      suggestedOptions: ['x86-64', 'RISC-V', 'AArch64'],
    },
    {
      key: 'kernel_language',
      label: 'Kernel language',
      description: 'The language they want to write the kernel in: C, Rust or Zig.',
      weight: 2,
      required: true,
      suggestedOptions: ['C', 'Rust', 'Zig', 'Recommend one for me'],
    },
    {
      key: 'host_os',
      label: 'Your computer',
      description: 'The operating system they develop on: Linux, macOS or Windows with WSL.',
      weight: 2,
      required: true,
      suggestedOptions: ['Linux', 'macOS', 'Windows (WSL 2)'],
    },
    {
      key: 'boot_path',
      label: 'Boot path',
      description: 'How the kernel is loaded: Limine, GRUB with Multiboot2, UEFI or their own bootloader.',
      weight: 1,
      required: false,
      suggestedOptions: ['Limine', 'GRUB + Multiboot2', 'UEFI', 'My own bootloader'],
    },
    {
      key: 'os_depth',
      label: 'How far',
      description: 'How far they want to go: boot and print, interrupts, memory, multitasking, userspace or a filesystem.',
      weight: 1,
      required: false,
      suggestedOptions: ['Boot and print', 'Interrupts and memory', 'Multitasking', 'Userspace and a shell'],
    },
  ],
  tierFloors: [
    { goal: 'A kernel that boots and prints', tier: 'T4', keywords: [] },
    {
      goal: 'An operating system past booting: memory, multitasking, userspace or a shell',
      tier: 'T5',
      keywords: [
        'operating system',
        'os',
        'shell',
        'userspace',
        'user space',
        'multitasking',
        'scheduler',
        'filesystem',
        'file system',
        'syscalls',
        'syscall',
        'paging',
        'virtual memory',
        'processes',
      ],
    },
  ],
  architectureRule: {
    description:
      'The kernel has a test mode that reports results over serial and exits QEMU with a status code ' +
      '(isa-debug-exit on x86, the SBI system-reset call on RISC-V). Host-testable pieces, such as ' +
      'allocators and parsers, live in a separate library with ordinary unit tests.',
    requiredPaths: ['kernel/**|src/**', 'tests/**|kernel/tests/**|src/tests/**'],
    firstStepCreates: ['Makefile|CMakeLists.txt|Cargo.toml|build.zig'],
    // Freestanding: no hosted C library inside the kernel.
    forbiddenImports: [{ in: 'kernel/**', packages: ['stdio.h', 'stdlib.h'] }],
  },
  harnesses: ['qemu-serial', 'unit'],
  browserRunnable: () => false,
  toolchain: [
    {
      tool: 'qemu-system-x86_64',
      minVersion: null,
      installHint: {
        linux: 'sudo apt install qemu-system-x86',
        macos: 'brew install qemu',
        windows: 'Inside WSL 2: sudo apt install qemu-system-x86',
      },
    },
    {
      tool: 'x86_64-elf-gcc',
      minVersion: null,
      installHint: {
        linux: 'Build a cross-compiler (OSDev wiki: GCC Cross-Compiler), or use clang --target=x86_64-elf',
        macos: 'brew install x86_64-elf-gcc',
        windows: 'Inside WSL 2: build a cross-compiler, or use clang --target=x86_64-elf',
      },
    },
    {
      tool: 'gdb',
      minVersion: null,
      installHint: { linux: 'sudo apt install gdb', macos: 'brew install gdb', windows: 'Inside WSL 2: sudo apt install gdb' },
    },
  ],
  docSources: [{ key: 'base' }, { key: 'profile:systems-os' }],
  prerequisites: [
    'Pointers and pointer arithmetic in C or unsafe Rust',
    'Hexadecimal, bits and bit masks',
    'How a program is compiled and linked',
    'Using a terminal, Make and Git',
    'Reading a hardware or specification document',
  ],
  promptAddendum: `<profile_rules profile="systems-os">
This is a hobby kernel. Rules that hold for every stage:
- Step 1 is always toolchain setup: the cross-compiler, QEMU and the build, checked before any kernel code.
- From milestone 1 the kernel has a test mode: it prints results over serial and exits QEMU with a status code through the isa-debug-exit device on x86 or the SBI system-reset call on RISC-V. Every step's check reads that serial output.
- Allocators, parsers and other pure logic live in a host-testable library with ordinary unit tests.
- Windows learners develop inside WSL 2.
- Each milestone ends with something that boots and prints. A T5 kernel plans milestone 1 only; later milestones follow when it is done.
</profile_rules>`,
};
