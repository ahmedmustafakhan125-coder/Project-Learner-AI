import { PROJECT_TIERS } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { HarnessKind, PROFILE_IDS, ProfileId } from '../src/profiles/types.js';
import { DocRef, ResearchDossier, parseStoredDossier } from '../src/schemas/research.js';
import {
  ComplexityTier,
  LayerChoice,
  StackBrief,
  parseStoredStackBrief,
} from '../src/schemas/stack.js';

/** The Project Learner schemas (docs/project-learner.md §6 to §8). */

const REF = {
  id: 'd1',
  url: 'https://wiki.osdev.org/Limine',
  title: 'Limine - OSDev Wiki',
  citedText: 'Limine is a modern, advanced, portable, multiprotocol bootloader.',
  retrievedAt: '2026-10-23T10:00:00Z',
  vetted: true,
};

const DOSSIER = {
  scope: 'project',
  notes: '## Boot\nLimine loads the kernel in long mode [d1].',
  docRefs: [REF],
  versions: [{ tech: 'Limine', versionSeen: '9', ref: 'd1' }],
  apis: [],
  toolchain: [{ tool: 'qemu-system-x86_64', install: 'apt install qemu-system-x86', ref: 'd1' }],
};

const LAYER = {
  layer: 'boot-protocol',
  name: 'Limine',
  versionMajor: '9',
  whatItIs: 'A bootloader that starts your kernel.',
  roleHere: 'Loads the kernel in 64-bit mode and hands it a memory map.',
  whyChosen: 'Less assembly than GRUB multiboot2 for a first kernel.',
  pros: ['Long mode set up for you', 'Good docs'],
  cons: ['Less common than GRUB'],
  learnerCost: 'Reading the boot protocol spec.',
  alternatives: [
    {
      name: 'GRUB multiboot2',
      pros: ['Everywhere'],
      cons: ['You set up long mode yourself'],
      pickWhen: 'You want to learn the mode switch.',
      switchCost: 'medium',
    },
  ],
  requestedByLearner: false,
  docRefs: ['d1'],
  verification: 'cli',
  cardId: 'limine',
};

const BRIEF = {
  profile: 'systems-os',
  tier: 'T5',
  summary: 'An x86-64 kernel that boots under QEMU.',
  layers: [LAYER],
  toolchain: [
    {
      tool: 'qemu-system-x86_64',
      minVersion: '8',
      installHint: { linux: 'apt install qemu-system-x86', macos: 'brew install qemu' },
    },
  ],
  architecture: {
    style: 'Limine + C kernel + serial',
    components: [{ id: 'k', name: 'Kernel', layer: 'boot-protocol', purpose: 'Runs' }],
    flows: [],
  },
  howItFitsTogether: 'QEMU starts Limine, which loads the kernel, which prints to serial.',
};

describe('ProfileId and tiers', () => {
  it('has the fourteen profiles of §6, general included', () => {
    expect(PROFILE_IDS).toHaveLength(14);
    expect(ProfileId.options).toContain('general');
    expect(ProfileId.safeParse('profiles').success).toBe(false);
  });

  it('keys tiers exactly as PROJECT_MODELS does', () => {
    expect(ComplexityTier.options).toEqual([...PROJECT_TIERS]);
  });

  it('names the §10 harnesses', () => {
    expect(HarnessKind.options).toEqual(
      expect.arrayContaining(['unit', 'exec-golden', 'golden-image', 'qemu-serial', 'sim-ticks']),
    );
  });
});

describe('ResearchDossier', () => {
  it('parses a dossier', () => {
    expect(ResearchDossier.safeParse(DOSSIER).success).toBe(true);
  });

  it('keeps cited snippets to 150 characters, never whole pages', () => {
    expect(DocRef.safeParse({ ...REF, citedText: 'x'.repeat(150) }).success).toBe(true);
    expect(DocRef.safeParse({ ...REF, citedText: 'x'.repeat(151) }).success).toBe(false);
  });

  it('rejects a reference that is not a URL', () => {
    expect(DocRef.safeParse({ ...REF, url: 'wiki.osdev.org' }).success).toBe(false);
  });

  it('reads back tolerantly: absent or unreadable is null', () => {
    expect(parseStoredDossier(null)).toBeNull();
    expect(parseStoredDossier({ scope: 'nope' })).toBeNull();
    expect(parseStoredDossier(DOSSIER)?.docRefs).toHaveLength(1);
  });
});

describe('StackBrief', () => {
  it('parses a brief and fills its defaults', () => {
    const parsed = StackBrief.parse(BRIEF);
    expect(parsed.milestones).toEqual([]);
    expect(parsed.layers[0]!.assumptions).toEqual([]);
  });

  it('wants at least two pros and one con per choice', () => {
    expect(LayerChoice.safeParse({ ...LAYER, pros: ['one'] }).success).toBe(false);
    expect(LayerChoice.safeParse({ ...LAYER, cons: [] }).success).toBe(false);
  });

  it('allows one or two alternatives, never three', () => {
    const alt = LAYER.alternatives[0]!;
    expect(LayerChoice.safeParse({ ...LAYER, alternatives: [] }).success).toBe(false);
    expect(LayerChoice.safeParse({ ...LAYER, alternatives: [alt, alt] }).success).toBe(true);
    expect(LayerChoice.safeParse({ ...LAYER, alternatives: [alt, alt, alt] }).success).toBe(false);
  });

  // `verifyStackBrief` wants a reference whenever the dossier holds one; a
  // brief written against an empty dossier is stored with none (limited sources).
  it('stores a layer with no reference, for a brief whose dossier was empty', () => {
    expect(LayerChoice.safeParse({ ...LAYER, docRefs: [] }).success).toBe(true);
  });

  it('reads back tolerantly for projects planned before PROJECT_LEARNER', () => {
    expect(parseStoredStackBrief(undefined)).toBeNull();
    expect(parseStoredStackBrief({ profile: 'systems-os' })).toBeNull();
    expect(parseStoredStackBrief(BRIEF)?.tier).toBe('T5');
  });
});
