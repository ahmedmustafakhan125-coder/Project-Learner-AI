'use client';

import Link from 'next/link';

export default function AboutPage() {
  const architectures = [
    {
      badge: 'Four answers in parallel',
      title: 'The four-tutor engine',
      description:
        'One answer is rarely enough. A question here goes to four tutors at the same time, and each starts writing immediately, so you read all four as they arrive rather than waiting for one long reply.',
      points: [
        'Plain English: no jargon, comparisons to things you already know, understanding before syntax.',
        'Industry practice: how this is really used at work, what it costs, and the ways it goes wrong.',
        'Hands-on: exercises, step-by-step drills, and the awkward cases worth trying yourself.',
        'Deep dive: what happens in memory, how fast it is, and where the official specs say so.',
      ],
    },
    {
      badge: 'Answers shaped around you',
      title: 'A few questions, not a guess',
      description:
        'Rather than guessing what you meant and padding the answer with whatever looked related, Project Learner asks you a few direct questions first — how much you already know, what you are working with, what you are trying to build — and writes every answer with that in mind.',
      points: [
        'A few clear questions, so the answer fits your level instead of a generic one.',
        'The four tutors share the same opening context, which makes answers arrive faster and cost less to produce.',
        'Keep getting a step wrong and the next one gets smaller. Breeze through and it gets bigger.',
        'Works with several AI providers: Google Gemini, Anthropic Claude, OpenAI, DeepSeek and Moonshot.',
      ],
    },
    {
      badge: 'Nothing to install',
      title: 'Code that runs in your browser',
      description:
        'No installs, no containers, and no setup that only works on one machine. Your code runs in the page you are already looking at, and you get an answer in about a second.',
      points: [
        'Python runs in the browser — the standard library, NumPy, and ordinary algorithm work — at close to normal speed.',
        'Your code runs sealed off in its own frame, so it cannot read the page, your cookies, or anything you are signed in to.',
        'A full code editor, the same one VS Code uses, with several files open at once.',
        'Every submission is checked by real tests, so you find out immediately whether it works.',
      ],
    },
    {
      badge: 'Private by default',
      title: 'What happens to what you type',
      description:
        'Everything you send is checked before it reaches an AI provider or the database.',
      points: [
        'Emails, API keys, phone numbers and other secrets are found and masked automatically.',
        'Attempts to hijack the AI with hidden instructions are caught and refused.',
        'You can see what you have spent and set a daily limit in dollars.',
        'Your projects, code and conversations are yours. No other account can read them.',
      ],
    },
  ];

  /*
   * The two people who built it.
   *
   * A link renders only when its value is non-empty, so a profile nobody has
   * supplied yet leaves no dead anchor on a public page. Fill `linkedin` in and
   * the button appears; leave it blank and the card simply shows GitHub.
   */
  const developers = [
    {
      name: 'Ahmed Mustafa',
      github: 'https://github.com/ahmedmustafakhan125-coder',
      linkedin: 'https://www.linkedin.com/in/mustafa-khan-7653a0304/',
    },
    {
      name: 'Ali Noor',
      github: 'https://github.com/alinoor4',
      linkedin: 'https://www.linkedin.com/in/ali-noor04/',
    },
  ];

  const pillars = [
    {
      num: '01',
      title: 'You build it yourself',
      blurb: 'Reading documentation makes you feel like you understand it. Writing code that actually has to run is what proves you do, so every step ends in code you run.',
    },
    {
      num: '02',
      title: 'Four explanations, not one',
      blurb: 'People click with different explanations. Getting four at once means you are not stuck waiting for the one that finally makes sense.',
    },
    {
      num: '03',
      title: 'Never too easy, never too hard',
      blurb: 'Stuck on the same step for an hour, or bored because it is all obvious? The work adjusts as you go, so it stays just past what you can already do.',
    },
    {
      num: '04',
      title: 'Safe to experiment',
      blurb: 'Personal details are stripped before anything reaches an AI model, and your code runs sealed off from everything else. Nothing you try here can break anything real.',
    },
  ];

  return (
    <main className="about-page-container">
      {/* Background ambience, shared with the landing page. Two bounded,
          heavily blurred orbs rather than a tint stretched over the whole
          container - see the note on `.about-hero-backdrop`'s removal. */}
      <div className="landing-glow-orb orb-primary" />
      <div className="landing-glow-orb orb-secondary" />

      {/* Hero Header */}
      <section className="about-hero-section">
        <div className="landing-badge">
          How Project Learner works
        </div>
        <h1 className="about-title">
          Learning that sticks, because <span>you build it yourself</span>
        </h1>
        <p className="about-subtitle">
          Project Learner is not a chatbot with a new coat of paint. Ask a question and four tutors answer from four different angles. Then you build a real project step by step, in your browser, with each step checked as you go.
        </p>
        <div className="about-hero-actions">
          <Link href="/ask" className="btn primary landing-cta-btn">
            Open the workspace →
          </Link>
          <Link href="/projects" className="btn ghost">
            Browse projects
          </Link>
        </div>
      </section>

      {/* Pedagogical Pillars */}
      <section className="about-pillars-section">
        <div className="section-header text-center">
          <span className="section-tag">The idea</span>
          <h2>Four things we build around</h2>
          <p className="section-desc">Based on how people actually learn, rather than how courses are usually sold.</p>
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
          <span className="section-tag">Under the hood</span>
          <h2>How it works, in more detail</h2>
          <p className="section-desc">For anyone who wants to know what is actually going on.</p>
        </div>

        <div className="architecture-stack">
          {architectures.map((arch) => (
            <div key={arch.title} className="arch-item glassmorphic-card">
              <div className="arch-header">
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
        <h3>Built with</h3>
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

      {/* The people who built it */}
      <section className="about-team-section">
        <div className="section-header text-center">
          <span className="section-tag">The team</span>
          <h2>Who built this</h2>
        </div>

        <div className="team-grid">
          {developers.map((dev) => (
            <div key={dev.name} className="team-card">
              <h3>{dev.name}</h3>
              <div className="team-links">
                {dev.github && (
                  <a
                    href={dev.github}
                    className="team-link"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    GitHub
                  </a>
                )}
                {dev.linkedin && (
                  <a
                    href={dev.linkedin}
                    className="team-link"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    LinkedIn
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="about-cta-section text-center">
        <h2>Ready to try it?</h2>
        <p>Open the workspace and ask a question, or start your first project.</p>
        <div className="cta-actions">
          <Link href="/login?mode=signup&next=/ask" className="btn primary landing-cta-btn">
            Get started free
          </Link>
          <Link href="/login?mode=signin" className="btn ghost">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
