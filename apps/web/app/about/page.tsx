'use client';

import Link from 'next/link';

export default function AboutPage() {
  const architectures = [
    {
      badge: 'Parallel Multi-Agent Reasoning',
      title: 'The 4-Specialist Perspective Engine',
      description:
        'Learning complex engineering cannot be reduced to a single monolithic answer. Project Learner splits queries across 4 specialized sub-agents running concurrently over multiplexed Server-Sent Events (SSE).',
      points: [
        'Plain English Specialist: Strips jargon, uses visual real-world analogies, and builds intuition first.',
        'Industry Context Specialist: Explains how top tech companies use this pattern in production, trade-offs, and failure modes.',
        'Hands-On Practice Specialist: Generates actionable exercises, step-by-step code drills, and edge-case experiments.',
        'Deep Architecture Specialist: Unpacks underlying memory layout, algorithmic complexity, runtime mechanics, and RFC specs.',
      ],
      icon: '✦',
    },
    {
      badge: 'Zero-Retrieval Deterministic Knowledge',
      title: 'Adaptive Context Interview & Prefixes',
      description:
        'Instead of opaque vector searches that hallucinate disconnected chunks, Project Learner conducts a deterministic slot-filling interview to extract the learner’s skill level, current tech stack, and learning objectives.',
      points: [
        'Deterministic Slot Extraction: Categorizes queries by topic, domain, technology, and skill level.',
        'Shared Cached Prefix: The 4 parallel agents share byte-identical prefix prompts, maximizing LLM cache hits and reducing latency.',
        'Adaptive Pacing Controller: Automatically scales difficulty up or inserts micro-scaffolds based on learner checkpoint attempt metrics.',
        'Model-Agnostic Engine: Built on Google Gemini 3.6 Flash, Anthropic Claude, OpenAI, DeepSeek, and Moonshot.',
      ],
      icon: '✦',
    },
    {
      badge: 'Zero-Setup Isolated Runtimes',
      title: 'In-Browser WebAssembly & JS Sandboxes',
      description:
        'No local installations, Docker containers, or environment mismatch bugs. Code execution happens safely directly inside the learner’s browser with sub-second feedback loops.',
      points: [
        'Pyodide WebAssembly Engine: Runs full Python stdlib, NumPy, and algorithms directly in-browser at near-native speeds.',
        'Dual-Tier CSP Isolation: Sandboxes run in sandboxed iframes with strict Content-Security-Policy rules, preventing DOM access or cookie leaks.',
        'Monaco IDE Integration: Full VS Code editor experience with syntax highlighting, auto-complete, and multi-file project tabs.',
        'Automated Checkpoint Verification: Real-time unit tests and regression assertions run against the student’s code on every submission.',
      ],
      icon: '✦',
    },
    {
      badge: 'Enterprise-Grade AI Security',
      title: 'FastAPI LLM Security Gateway',
      description:
        'Every learner prompt and file upload is screened before reaching the LLM providers or database to guarantee safety and compliance.',
      points: [
        'PII Redaction Engine: Automatically detects and masks emails, API keys, phone numbers, and secrets.',
        'Prompt Injection Guard: Scans incoming requests against prompt injection patterns and adversarial system overrides.',
        'Transparent Token Accounting: Real-time token usage meter and daily USD budget caps per user.',
        'Row-Level Security (RLS): All projects, blueprints, checkpoints, and chat histories are private to each authenticated learner.',
      ],
      icon: '✦',
    },
  ];

  const pillars = [
    {
      num: '01',
      title: 'Active Construction',
      blurb: 'Reading documentation produces the illusion of competence. Project Learner forces active synthesis through executable code milestones.',
    },
    {
      num: '02',
      title: 'Multi-Angle Scaffolding',
      blurb: 'Different brains resonate with different representations. Four distinct perspectives ensure intuition precedes syntax.',
    },
    {
      num: '03',
      title: 'Adaptive Cognitive Load',
      blurb: 'Never get stuck in tutorial hell or overwhelmed by overly dense RFCs. Work is continuously adjusted to your current edge of ability.',
    },
    {
      num: '04',
      title: 'Safety by Default',
      blurb: 'Automated PII scrubbing and sandbox isolation allow fear-free experimentation with sensitive or production-adjacent concepts.',
    },
  ];

  return (
    <main className="about-page-container">
      {/* Background Ambience */}
      <div className="about-hero-backdrop" />

      {/* Hero Header */}
      <section className="about-hero-section">
        <div className="landing-badge">
          <span className="badge-spark">✦</span> Architecture & Pedagogy Deep Dive
        </div>
        <h1 className="about-title">
          Engineering the Future of <span>AI-Driven Technical Mastery</span>
        </h1>
        <p className="about-subtitle">
          Project Learner is not another generic AI chatbot wrapper. It is a pedagogical compiler designed to turn complex software engineering concepts into durable, milestone-driven mastery through parallel agent perspectives, in-browser sandboxes, and adaptive pacing.
        </p>
        <div className="about-hero-actions">
          <Link href="/ask" className="btn primary landing-cta-btn">
            Open Workspace →
          </Link>
          <Link href="/projects" className="btn ghost">
            Explore Project Blueprints
          </Link>
        </div>
      </section>

      {/* Pedagogical Pillars */}
      <section className="about-pillars-section">
        <div className="section-header text-center">
          <span className="section-tag">Core Pedagogy</span>
          <h2>The Four Cognitive Pillars</h2>
          <p className="section-desc">Designed according to modern cognitive science and cognitive load theory.</p>
        </div>

        <div className="pillars-grid">
          {pillars.map((pillar) => (
            <div key={pillar.num} className="pillar-card glassmorphic-card">
              <div className="pillar-num">{pillar.num}</div>
              <h3>{pillar.title}</h3>
              <p>{pillar.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture Deep Dive */}
      <section className="about-architecture-section">
        <div className="section-header text-center">
          <span className="section-tag">Technical Architecture</span>
          <h2>How Project Learner Works Under the Hood</h2>
          <p className="section-desc">A deep dive into the engineering choices behind our high-throughput, low-latency system.</p>
        </div>

        <div className="architecture-stack">
          {architectures.map((arch) => (
            <div key={arch.title} className="arch-item glassmorphic-card">
              <div className="arch-header">
                <div className="arch-icon-badge">{arch.icon}</div>
                <div>
                  <span className="arch-badge">{arch.badge}</span>
                  <h3>{arch.title}</h3>
                </div>
              </div>
              <p className="arch-desc">{arch.description}</p>
              <ul className="arch-points">
                {arch.points.map((point) => (
                  <li key={point}>
                    <span className="point-bullet">✓</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Tech Stack Banner */}
      <section className="about-stack-section glassmorphic-card">
        <h3>Built With Modern Open-Source Standards</h3>
        <div className="tech-pills-row">
          <span className="tech-pill">Next.js 16 (App Router + Turbopack)</span>
          <span className="tech-pill">Fastify API Gateway</span>
          <span className="tech-pill">Google Gemini 3.6 Flash</span>
          <span className="tech-pill">Supabase PostgreSQL + RLS</span>
          <span className="tech-pill">Pyodide WebAssembly</span>
          <span className="tech-pill">Monaco Editor</span>
          <span className="tech-pill">FastAPI Security Proxy</span>
          <span className="tech-pill">TypeScript Strict Monorepo</span>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="about-cta-section text-center">
        <h2>Ready to Experience Active Technical Learning?</h2>
        <p>Launch the 4-agent parallel workspace or generate your first custom project blueprint in seconds.</p>
        <div className="cta-actions">
          <Link href="/login?mode=signup&next=/ask" className="btn primary landing-cta-btn">
            Get Started Free
          </Link>
          <Link href="/login?mode=signin" className="btn ghost">
            Sign In to Existing Account
          </Link>
        </div>
      </section>
    </main>
  );
}
