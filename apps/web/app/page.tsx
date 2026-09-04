'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
      tag: 'Plain English & Intuition',
      title: 'Simple & Intuitive Explanation',
      color: 'var(--agent-conceptual)',
      excerpt:
        'Think of a Closure like a backpack a function wears when it goes out into the world. Even when the outer function has finished executing and packed up, the inner function still keeps whatever variables were in its backpack wherever it travels.',
      bullets: ['Strips out unnecessary jargon', 'Uses real-world mental models', 'Builds foundational intuition before syntax'],
    },
    industry: {
      tag: 'Production Patterns & Trade-offs',
      title: 'Industry Context & Production Patterns',
      color: 'var(--agent-practical)',
      excerpt:
        'At scale (e.g., in React state handlers or Node.js event listeners), uncollected closures can hold large DOM trees or database pools in memory. Senior engineers use closures for data encapsulation and factory functions while being mindful of circular references.',
      bullets: ['Production war stories & failure modes', 'Memory leak prevention strategies', 'Architecture trade-offs at scale'],
    },
    practice: {
      tag: 'Hands-On Exercises & Drills',
      title: 'Hands-On Sandbox Practice',
      color: 'var(--agent-interactive)',
      excerpt:
        'Exercise: Build a resilient token bucket rate limiter using a closure to store the token count and timestamp privately without exposing internal variables to global scope. Try modifying the leak test in the sandbox.',
      bullets: ['Executable code snippets', 'Self-verifying test checkpoints', 'Progressive micro-drills'],
    },
    concepts: {
      tag: 'Underlying Mechanics & RFC Specs',
      title: 'Deep Architecture & Runtime Internals',
      color: 'var(--agent-takeaways)',
      excerpt:
        'Under the V8 engine, closures are represented via ScopeInfo and Context heap objects. When an inner function references outer bindings, those bindings are allocated on the heap rather than the stack frame, surviving LIFO deallocation.',
      bullets: ['V8 / JS runtime heap layout', 'Time and space complexity proofs', 'Standards specifications & RFC citations'],
    },
  };

  const samplePromptChips = [
    'How do closures work and impact memory in JavaScript?',
    'Design a distributed rate limiter with Redis and token buckets',
    'Explain async/await vs Promises with practical production patterns',
    'Why do we need useEffect cleanup functions in React?',
  ];

  return (
    <main className="landing-page-root">
      {/* Dynamic Background Glows */}
      <div className="landing-glow-orb orb-primary" />
      <div className="landing-glow-orb orb-secondary" />

      {/* Hero Section */}
      <section className="landing-hero-section">
        <div className="landing-badge">
          <span className="badge-spark">✦</span> Multi-Agent Active Learning Platform
        </div>

        <h1 className="landing-hero-title">
          Master Software Engineering Through <br />
          <span className="gradient-text">Active Building</span> & <span className="gradient-text">4 Parallel Perspectives</span>
        </h1>

        <p className="landing-hero-subtitle">
          Break free from passive video tutorials. Ask any complex concept to receive 4 simultaneous specialist perspectives, then build milestone-driven projects in our zero-setup browser sandbox.
        </p>

        {/* Hero Interactive Prompt Input */}
        <form onSubmit={handleSearch} className="landing-hero-search-box glassmorphic-card">
          <span className="search-icon">✦</span>
          <input
            type="text"
            className="hero-search-input"
            placeholder="Ask any question (e.g. Closures, Redis, Async)..."
            value={heroInput}
            onChange={(e) => setHeroInput(e.target.value)}
          />
          <button type="submit" className="btn primary hero-search-btn">
            Explore with 4 Agents →
          </button>
        </form>

        {/* Quick prompt chips */}
        <div className="landing-prompt-chips">
          <span className="chips-label">Popular explorations:</span>
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
            Launch 4-Agent Workspace
          </Link>
          <Link href="/projects" className="btn ghost landing-secondary-btn">
            Browse Project Blueprints
          </Link>
          <Link href="/about" className="btn ghost landing-secondary-btn">
            How It Works
          </Link>
        </div>
      </section>

      {/* Interactive 4-Agent Showcase */}
      <section className="landing-showcase-section">
        <div className="section-header text-center">
          <span className="section-tag">Why 4 Agents?</span>
          <h2>One Question. Four Specialized Angles. Zero Jargon Gaps.</h2>
          <p className="section-desc">
            Traditional AI gives you a single generic wall of text. Project Learner parallelizes your query across 4 specialized agents.
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
                  <span className="tab-spark" style={{ color: info.color }}>✦</span>
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
              <span className="showcase-live-indicator">Streaming Live via SSE</span>
            </div>

            <p className="showcase-excerpt">{agentSamples[activeTab].excerpt}</p>

            <div className="showcase-bullets">
              {agentSamples[activeTab].bullets.map((bullet) => (
                <div key={bullet} className="bullet-item">
                  <span className="bullet-icon">✦</span>
                  <span>{bullet}</span>
                </div>
              ))}
            </div>

            <div className="showcase-footer">
              <span className="model-pill">Powered by Google Gemini 3.6 Flash</span>
              <Link href="/ask" className="showcase-action-link">
                Ask your own question in Workspace →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Core Platform Features Grid */}
      <section className="landing-features-section">
        <div className="section-header text-center">
          <span className="section-tag">Complete System</span>
          <h2>Engineered for Accelerated Technical Mastery</h2>
          <p className="section-desc">Everything you need to go from curiosity to building production-grade software.</p>
        </div>

        <div className="features-grid">
          <div className="feature-card glassmorphic-card">
            <div className="feature-icon-box">✦</div>
            <h3>4-Specialist Fan-Out</h3>
            <p>
              Queries are broadcast across 4 agents running in parallel over multiplexed Server-Sent Events, sharing a cached prompt prefix.
            </p>
            <div className="feature-meta">Multiplexed SSE • Shared Prefix Caching</div>
          </div>

          <div className="feature-card glassmorphic-card">
            <div className="feature-icon-box">✦</div>
            <h3>Adaptive Project Blueprints</h3>
            <p>
              Generate milestone-driven coding projects with instructions, checkpoints, hints, and automated difficulty scaling based on your progress.
            </p>
            <div className="feature-meta">Phased Expansion • Pacing Directives</div>
          </div>

          <div className="feature-card glassmorphic-card">
            <div className="feature-icon-box">✦</div>
            <h3>In-Browser Code Sandboxes</h3>
            <p>
              Run Python stdlib and algorithms via Pyodide WebAssembly or execute JavaScript/TypeScript with Monaco editor and zero local environment setup.
            </p>
            <div className="feature-meta">Pyodide WASM • Monaco IDE • Strict CSP</div>
          </div>

          <div className="feature-card glassmorphic-card">
            <div className="feature-icon-box">✦</div>
            <h3>Enterprise AI Security</h3>
            <p>
              Automated PII masking, prompt injection defense with FastAPI, and transparent daily USD budget limits safeguard every interaction.
            </p>
            <div className="feature-meta">PII Redaction • Injection Defense • RLS</div>
          </div>
        </div>
      </section>

      {/* 3-Step Journey */}
      <section className="landing-journey-section">
        <div className="section-header text-center">
          <span className="section-tag">How It Works</span>
          <h2>Three Steps to True Technical Fluency</h2>
        </div>

        <div className="journey-steps-row">
          <div className="journey-step glassmorphic-card">
            <div className="step-num">01</div>
            <h4>Ask & Slot-Filling Interview</h4>
            <p>Type your query or let our deterministic interview extract your stack and goals to tailor every answer.</p>
          </div>

          <div className="journey-step-connector">→</div>

          <div className="journey-step glassmorphic-card">
            <div className="step-num">02</div>
            <h4>Synthesize 4 Perspectives</h4>
            <p>Watch Plain English, Industry Context, Hands-on Drills, and Core Architecture stream simultaneously.</p>
          </div>

          <div className="journey-step-connector">→</div>

          <div className="journey-step glassmorphic-card">
            <div className="step-num">03</div>
            <h4>Build in Sandbox Checkpoints</h4>
            <p>Write executable code in the browser. Automated verification checks your solutions instantly.</p>
          </div>
        </div>
      </section>

      {/* Call to Action Banner */}
      <section className="landing-bottom-banner glassmorphic-card">
        <div className="banner-content text-center">
          <div className="landing-badge">
            <span className="badge-spark">✦</span> Ready to level up your engineering skills?
          </div>
          <h2>Join Project Learner Today</h2>
          <p>Instant access to the 4-Agent Workspace, project blueprint generator, and in-browser execution sandbox.</p>
          <div className="banner-buttons">
            <Link href="/login?mode=signup&next=/ask" className="btn primary landing-cta-btn">
              Get Started Free
            </Link>
            <Link href="/login?mode=signin" className="btn ghost">
              Sign In to Account
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="brand-title">Project <span>Learner</span></span>
            <p className="footer-blurb">Modern multi-agent AI educational workspace for software engineers.</p>
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
