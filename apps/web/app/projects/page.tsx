'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProjectSummary } from '@ai-edu/api-client';

import { AuthGate } from '../../components/AuthGate';
import { api } from '../../lib/api';

export default function ProjectsPage() {
  return (
    <AuthGate>
      <Projects />
    </AuthGate>
  );
}

function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load your projects.');
        setProjects([]);
      });
  }, []);

  return (
    <main className="shell wide">
      <header className="masthead">
        <div>
          <h1>Interactive Projects</h1>
          <div className="sub">Hands-on coding blueprints with live in-browser execution, test runners, and hints.</div>
        </div>
        <Link className="btn primary" href="/projects/new">
          <span>⚡ Generate New Blueprint</span>
        </Link>
      </header>

      {error && <div className="notice error">{error}</div>}
      {projects === null && (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <p className="skeleton">Loading your project library…</p>
        </div>
      )}

      {projects?.length === 0 && !error && (
        <div className="empty" style={{ background: 'var(--surface)', borderRadius: '16px', border: '1px solid var(--border)', padding: '60px 24px' }}>
          <div style={{ fontSize: '36px', marginBottom: '12px' }}>🚀</div>
          <h2 style={{ fontSize: '20px', margin: '0 0 8px' }}>No projects generated yet</h2>
          <p className="muted" style={{ maxWidth: '440px', margin: '0 auto 24px' }}>
            Tell Lumina AI what technology, game, or tool you want to build and it will create a tailored blueprint.
          </p>
          <Link href="/projects/new" className="btn primary">
            Create Your First Project
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-cards">
          {projects.map((project) => (
            <Link className="project-card" key={project.id} href={`/projects/${project.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
                <h3>{project.title}</h3>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontFamily: 'var(--mono)',
                    background: project.status === 'completed' ? 'var(--success-soft)' : 'var(--accent-soft)',
                    color: project.status === 'completed' ? 'var(--success)' : '#a5b4fc',
                    border: '1px solid currentColor',
                  }}
                >
                  {project.status}
                </span>
              </div>
              <p className="muted" style={{ fontSize: '13.5px', minHeight: '42px', marginBottom: '14px' }}>
                {project.summary}
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span
                  style={{
                    fontSize: '11.5px',
                    padding: '3px 10px',
                    borderRadius: '999px',
                    background: 'var(--surface-3)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-dim)',
                  }}
                >
                  🎓 {project.skill_level}
                </span>
                {project.estimated_hours !== null && (
                  <span
                    style={{
                      fontSize: '11.5px',
                      padding: '3px 10px',
                      borderRadius: '999px',
                      background: 'var(--surface-3)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-dim)',
                    }}
                  >
                    ⏱️ ~{project.estimated_hours}h
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--primary)', fontWeight: 600 }}>
                  Open Studio →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
