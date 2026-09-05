'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProjectSummary } from '@ai-edu/api-client';

import { AuthGate } from '../../components/AuthGate';
import { api } from '../../lib/api';
import { BrandLogo } from '@/components/BrandLogo';

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
  /** The project the learner has asked to delete, pending confirmation. */
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete(project: ProjectSummary) {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      // Dropped locally rather than refetched: the list is already on screen
      // and a round trip would flash it away and back.
      setProjects((current) => current?.filter((p) => p.id !== project.id) ?? null);
      setPendingDelete(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete that project.');
    } finally {
      setDeleting(false);
    }
  }

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
          <span>Generate New Blueprint</span>
        </Link>
      </header>

      {error && <div className="notice error">{error}</div>}
      {projects === null && (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <p className="skeleton">Loading your project library…</p>
        </div>
      )}

      {projects?.length === 0 && !error && (
        <div className="empty" style={{ background: 'var(--surface)', borderRadius: '16px', border: '1px solid var(--border)', padding: '60px 24px', textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><BrandLogo height={40} /></div>
          <h2 style={{ fontSize: '20px', margin: '0 0 8px' }}>No projects generated yet</h2>
          <p className="muted" style={{ maxWidth: '440px', margin: '0 auto 24px' }}>
            Tell Project Learner what technology, game, or tool you want to build and it will create a tailored blueprint.
          </p>
          <Link href="/projects/new" className="btn primary">
            Create Your First Project
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-cards">
          {/*
            The card is a link, and a <button> cannot live inside an <a>. Hence
            the wrapper: the link keeps the whole card clickable, and delete
            sits over it as a sibling rather than nested inside it.
          */}
          {projects.map((project) => (
            <div className="project-card-wrap" key={project.id}>
              <Link className="project-card" href={`/projects/${project.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', paddingRight: '30px' }}>
                <h3>{project.title}</h3>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontFamily: 'var(--mono)',
                    background: project.status === 'completed' ? 'var(--success-soft)' : 'var(--agent-conceptual-bg)',
                    color: project.status === 'completed' ? 'var(--success)' : 'var(--primary)',
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
                  Skill Level: {project.skill_level}
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
                    ~{project.estimated_hours}h est.
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--primary)', fontWeight: 600 }}>
                  Open Studio →
                </span>
              </div>
            </Link>
              <button
                type="button"
                className="project-card-delete"
                onClick={() => setPendingDelete(project)}
                aria-label={`Delete ${project.title}`}
                title="Delete this project"
              >
                <span aria-hidden="true">&#10005;</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingDelete && (
        <DeleteProjectDialog
          project={pendingDelete}
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete(pendingDelete)}
        />
      )}
    </main>
  );
}

/**
 * Confirmation for a delete that cannot be undone.
 *
 * Typing something is asked for rather than a plain OK, because this removes
 * the learner's own code - every attempt they passed, every draft they were
 * mid-way through - and a misplaced click on a card should not be able to do
 * that. The word is fixed rather than the project title: long titles turn a
 * safety check into a transcription exercise, and the point is deliberate
 * intent, not typing accuracy.
 */
function DeleteProjectDialog({
  project,
  busy,
  onCancel,
  onConfirm,
}: {
  project: ProjectSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toLowerCase() === 'delete';

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel();
        }}
      >
        <h2 id="delete-project-title">Delete “{project.title}”?</h2>
        <p className="muted">
          This removes the project, all of its steps, and every attempt and draft you have saved
          against them. Your code for this project goes with it. This cannot be undone.
        </p>

        <label className="dialog-field">
          <span>
            Type <strong>delete</strong> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && armed && !busy) onConfirm();
            }}
          />
        </label>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Keep it
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={onConfirm}
            disabled={!armed || busy}
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  );
}
