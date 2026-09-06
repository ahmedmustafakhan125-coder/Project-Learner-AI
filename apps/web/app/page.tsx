'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * The four platform features, each with its own character.
 *
 * The bot replaces the diamond that used to sit here rather than joining it —
 * two marks in the same slot would compete. Colour is the mapping: each card
 * keeps the same character everywhere it appears, so the cast stays learnable.
 *
 * Extracted from the reference sheet into public/bots/ with the plate removed;
 * they are decorative, so each is aria-hidden and the heading carries meaning.
 */
const PLATFORM_FEATURES = [
  {
    title: 'Four Answers at Once',
    bot: '/bots/purple.png',
    body: 'Ask once and four tutors answer at the same time, each from a different angle. You watch all four arrive together instead of waiting for one long reply.',
    meta: 'Four angles • One question',
  },
  {
    title: 'Projects That Adapt to You',
    bot: '/bots/blue.png',
    body: 'Get a real coding project broken into steps, each with instructions, hints, and a check that tells you when it works. Steps get bigger or smaller depending on how you are doing.',
    meta: 'Step by step • Adjusts to your pace',
  },
  {
    title: 'Write Code in Your Browser',
    bot: '/bots/green.png',
    body: 'Run Python or JavaScript straight from the page, in a proper code editor. Nothing to install, nothing to configure, and no setup that only works on one machine.',
    meta: 'Python and JavaScript • No setup',
  },
  {
    title: 'Your Details Stay Private',
    bot: '/bots/terracotta.png',
    body: 'Personal details and keys are stripped out before anything reaches an AI model, your code runs sealed off from the rest of the page, and you can see exactly what you have spent.',
    meta: 'Private by default • Spending you can see',
  },
] as const;


export default function HomePage() {
  const router = useRouter();
  const [heroInput, setHeroInput] = useState('');
  const [activeTab, setActiveTab] = useState<'simple' | 'industry' | 'practice' | 'concepts'>('simple');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!heroInput.trim()) {
      router.push('/ask');
      return;
    }
    router.push(`/ask?q=${encodeURIComponent(heroInput.trim())}`);
  };

  const agentSamples = {
    simple: {
      tag: 'Plain English & everyday comparisons',
      title: 'Simple & clear explanation',
      color: 'var(--agent-conceptual)',
      excerpt:
        'Think of a closure as a backpack a function wears when it leaves home. The outer function finishes and packs up, but the inner function keeps carrying the variables that were in the backpack, wherever it goes.',
      bullets: ['No jargon to decode first', 'Comparisons to things you already know', 'Understanding first, syntax second'],
    },
    industry: {
      tag: 'Real production code & trade-offs',
      title: 'Industry practice, and what it costs',
      color: 'var(--agent-practical)',
      excerpt:
        'In a real app — a React state handler, say, or a Node event listener — a closure nobody cleans up can quietly hold on to a large chunk of memory long after it is needed. Experienced engineers use closures to keep data private, and watch carefully for the ones that never get released.',
      bullets: ['What actually goes wrong in real systems', 'How to avoid the memory leaks', 'The trade-off behind each choice'],
    },
    practice: {
      tag: 'Exercises & practice drills',
      title: 'Hands-on practice you run yourself',
      color: 'var(--agent-interactive)',
      excerpt:
        'Exercise: build something that limits how often an action can run, using a closure to keep its counter private so nothing outside can reach in and change it. Then try to break it in the sandbox and watch what happens.',
      bullets: ['Code you can run straight away', 'Checks that tell you if it works', 'Small steps that add up'],
    },
    concepts: {
      tag: 'What happens underneath',
      title: 'Deep dive into how it really works',
      color: 'var(--agent-takeaways)',
      excerpt:
        'Normally a function’s variables are thrown away the moment it returns. When an inner function still needs them, the engine moves them somewhere longer-lived instead, and that is the whole trick behind closures — the variables outlive the call that created them.',
      bullets: ['What the engine is really doing', 'Why it costs the time and memory it does', 'Where the official specs say so'],
    },
  };

  const samplePromptChips = [
    'How do closures work, and why can they leak memory?',
    'How would I build a rate limiter with Redis?',
    'What is the difference between async/await and Promises?',
    'Why does useEffect need a cleanup function?',
  ];

  return (
    <main className="landing-page-root">
      {/* Dynamic Background Glows */}
      <div className="landing-glow-orb orb-primary" />
      <div className="landing-glow-orb orb-secondary" />

      {/* Hero Section */}
      <section className="landing-hero-section">
        <div className="landing-badge">
          Learn by building, with four tutors
        </div>

        <h1 className="landing-hero-title">
          Master Software Engineering Through <br />
          <span className="gradient-text">Active Building</span> & <span className="gradient-text">4 Parallel Perspectives</span>
        </h1>

        <p className="landing-hero-subtitle">
          Watching tutorials is easy, and easy to forget. Here you ask a question and four tutors answer at the same time, each from a different angle. Then you build a real project in your browser, one checked step at a time, with nothing to install.
        </p>

        {/* Hero Interactive Prompt Input */}
        <form onSubmit={handleSearch} className="landing-hero-search-box glassmorphic-card">
          <input
            type="text"
            className="hero-search-input"
            placeholder="Ask anything (closures, Redis, async...)"
            value={heroInput}
            onChange={(e) => setHeroInput(e.target.value)}
          />
          <button type="submit" className="btn primary hero-search-btn">
            Ask all four →
          </button>
        </form>

        {/* Quick prompt chips */}
        <div className="landing-prompt-chips">
          <span className="chips-label">Popular questions:</span>
          {samplePromptChips.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="landing-prompt-chip"
              onClick={() => {
                setHeroInput(prompt);
                router.push(`/ask`);
              }}
            >
              {prompt}
            </button>
          ))}
        </div>

        {/* Hero CTAs */}
        <div className="landing-hero-actions">
          <Link href="/ask" className="btn primary landing-cta-btn">
            Open the workspace
          </Link>
          <Link href="/projects" className="btn ghost landing-secondary-btn">
            Browse projects
          </Link>
          <Link href="/about" className="btn ghost landing-secondary-btn">
            How it works
          </Link>
        </div>
      </section>

      {/* Interactive 4-Agent Showcase */}
      <section className="landing-showcase-section">
        <div className="section-header text-center">
          <span className="section-tag">Why four?</span>
          <h2>One question, four different explanations</h2>
          <p className="section-desc">
            Most AI tools hand you one long block of text. If it does not click, you are stuck. Four takes on the same question means at least one usually lands.
          </p>
        </div>

        <div className="showcase-card glassmorphic-card">
          {/* Agent Tabs */}
          <div className="showcase-tabs">
            {(['simple', 'industry', 'practice', 'concepts'] as const).map((key) => {
              const info = agentSamples[key];
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`showcase-tab-btn ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveTab(key)}
                  style={{ '--tab-color': info.color } as React.CSSProperties}
                >
                  <span className="tab-spark" aria-hidden="true" />
                  <span className="tab-title">{info.title.split(' ')[0]}</span>
                  <span className="tab-tag">{info.tag.split('&')[0]}</span>
                </button>
              );
            })}
          </div>

          {/* Active Agent Preview Body */}
          <div className="showcase-body">
            <div className="showcase-body-header">
              <div className="agent-badge" style={{ borderColor: agentSamples[activeTab].color }}>
                <span className="agent-dot" style={{ backgroundColor: agentSamples[activeTab].color }} />
                <span>{agentSamples[activeTab].title}</span>
              </div>
              <span className="showcase-live-indicator">Answering live</span>
            </div>

            <p className="showcase-excerpt">{agentSamples[activeTab].excerpt}</p>

            <div className="showcase-bullets">
              {agentSamples[activeTab].bullets.map((bullet) => (
                <div key={bullet} className="bullet-item">
                  <span className="bullet-icon" aria-hidden="true" />
                  <span>{bullet}</span>
                </div>
              ))}
            </div>

            <div className="showcase-footer">
              <span className="model-pill">Powered by Google Gemini 3.6 Flash</span>
              <Link href="/ask" className="showcase-action-link">
                Ask your own question →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Core Platform Features Grid */}
      <section className="landing-features-section">
        <div className="section-header text-center">
          <span className="section-tag">What you get</span>
          <h2>Everything in one place</h2>
          <p className="section-desc">From a question you cannot answer to a finished project you can show people.</p>
        </div>

        <div className="features-grid">
          {PLATFORM_FEATURES.map((feature) => (
            <div key={feature.title} className="feature-card glassmorphic-card">
              <div className="feature-icon-box">
                <img
                  src={feature.bot}
                  alt=""
                  aria-hidden="true"
                  className="bot-character"
                  width={44}
                  height={44}
                />
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <div className="feature-meta">{feature.meta}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3-Step Journey */}
      <section className="landing-journey-section">
        <div className="section-header text-center">
          <span className="section-tag">How it works</span>
          <h2>Three steps</h2>
        </div>

        <div className="journey-steps-row">
          <div className="journey-step glassmorphic-card">
            <div className="step-num">01</div>
            <h4>Ask, and answer a few questions</h4>
            <p>Type what you want to know. A few short questions work out what you already know and what you are building, so the answers fit you.</p>
          </div>

          <div className="journey-step-connector">→</div>

          <div className="journey-step glassmorphic-card">
            <div className="step-num">02</div>
            <h4>Read four answers at once</h4>
            <p>Plain English, how it is really used at work, exercises to try, and what happens underneath — all arriving together.</p>
          </div>

          <div className="journey-step-connector">→</div>

          <div className="journey-step glassmorphic-card">
            <div className="step-num">03</div>
            <h4>Build it, and get it checked</h4>
            <p>Write real code in your browser. Every step is checked automatically, so you know straight away whether it works.</p>
          </div>
        </div>
      </section>

      {/* Call to Action Banner */}
      <section className="landing-bottom-banner glassmorphic-card">
        <div className="banner-content text-center">
          <div className="landing-badge">
            Ready to start?
          </div>
          <h2>Join Project Learner</h2>
          <p>Free to start. You get the four-tutor workspace, the project builder, and a code sandbox that runs in your browser.</p>
          <div className="banner-buttons">
            <Link href="/login?mode=signup&next=/ask" className="btn primary landing-cta-btn">
              Get started free
            </Link>
            <Link href="/login?mode=signin" className="btn ghost">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <BrandLogo height={34} />
            <p className="footer-blurb">Learn software engineering by building, with four tutors explaining as you go.</p>
          </div>
          <div className="footer-links">
            <Link href="/ask">Workspace</Link>
            <Link href="/projects">Projects Library</Link>
            <Link href="/projects/new">Create Blueprint</Link>
            <Link href="/about">About Architecture</Link>
            <Link href="/login?mode=signin">Sign In</Link>
          </div>
        </div>
        <div className="footer-bottom text-center">
          <p>© {new Date().getFullYear()} Project Learner. Built with Next.js, Fastify, Supabase & Gemini 3.6 Flash.</p>
        </div>
      </footer>
    </main>
  );
}
