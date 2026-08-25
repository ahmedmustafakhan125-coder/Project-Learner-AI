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
    <main className="shell">
      <nav className="top">
        <Link href="/ask">Ask</Link>
        <Link href="/projects">Projects</Link>
      </nav>

      <header className="masthead">
        <div>
          <h1>Your projects</h1>
          <div className="sub">Build something real, one step at a time.</div>
        </div>
        <Link className="btn primary" href="/projects/new" style={{ textDecoration: 'none' }}>
          Start a project
        </Link>
      </header>

      {error && <div className="notice error">{error}</div>}
      {projects === null && <p className="skeleton">Loading…</p>}

      {projects?.length === 0 && !error && (
        <div className="empty">
          <p>No projects yet.</p>
          <p className="muted">
            Tell the platform what you want to build and it will design one around it.
          </p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-cards">
          {projects.map((project) => (
            <Link className="project-card" key={project.id} href={`/projects/${project.id}`}>
              <h3>{project.title}</h3>
              <p className="muted">{project.summary}</p>
              <div className="facts" style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="tag">{project.skill_level}</span>
                {project.estimated_hours !== null && (
                  <span className="tag">~{project.estimated_hours}h</span>
                )}
                <span className="tag">{project.status}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
