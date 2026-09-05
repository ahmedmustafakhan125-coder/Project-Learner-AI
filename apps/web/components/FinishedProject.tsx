'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ProjectArtifact } from '@ai-edu/core';
import { ApiError, type CompletenessReport } from '@ai-edu/api-client';

import { renderMarkdown } from '@/lib/markdown';
import { api } from '../lib/api';

/**
 * The finished project.
 *
 * Steps taught the learner to build the thing; this is where they get the
 * thing. Assembling it is free — it is their own code from every step, overlaid
 * in order — but the README and deploy config are written by a model against
 * that code, so producing them is an explicit, paid action rather than
 * something that happens on page load.
 *
 * The honesty about provenance is deliberate. A project assembled partly from
 * reference solutions is still worth having, but a learner about to put it in
 * front of an interviewer should know which parts they did not write.
 */

export interface FinishedProjectProps {
  projectId: string;
  projectTitle: string;
  /** Steps the learner has actually passed. Below this, finishing is premature. */
  passedCount: number;
  totalSteps: number;
}

export function FinishedProject({
  projectId,
  projectTitle,
  passedCount,
  totalSteps,
}: FinishedProjectProps) {
  const [artifact, setArtifact] = useState<ProjectArtifact | null>(null);
  /*
   * Whether this is actually the project that was planned.
   *
   * Nothing used to ask. A project could reach its final step still missing a
   * file the blueprint called for, and the first the learner knew was a
   * downloaded repository that does not start.
   */
  const [completeness, setCompleteness] = useState<CompletenessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  const build = useCallback(
    async (regenerate: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const { artifact: built, completeness: report } = await api.finishProject(
          projectId,
          regenerate,
        );
        setCompleteness(report ?? null);
        setArtifact(built);
        setOpenFile(null);
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const download = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await api.exportProject(projectId);
      // The export is authenticated, so it arrives as a blob rather than a
      // link: a bare href would reach the API without the bearer token.
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${slug(projectTitle)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(describe(err));
    } finally {
      setDownloading(false);
    }
  }, [projectId, projectTitle]);

  const complete = totalSteps > 0 && passedCount >= totalSteps;
  const selected = useMemo(
    () => artifact?.files.find((file) => file.path === openFile) ?? null,
    [artifact, openFile],
  );

  return (
    <section className="finished" aria-label="Finished project">
      <header className="finished-head">
        <div>
          <h2>Your finished project</h2>
          <p className="muted">
            {complete
              ? 'Every step is done. Assemble it into one repository you can show someone.'
              : `${passedCount} of ${totalSteps} steps passed. You can assemble it now — steps you have not finished will use the reference solution.`}
          </p>
        </div>

        <div className="finished-actions">
          {artifact && (
            <button
              type="button"
              className="btn"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? 'Preparing…' : '↓ Download .zip'}
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => void build(artifact !== null)}
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="loading-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                Writing the README…
              </>
            ) : artifact ? (
              'Rebuild'
            ) : (
              'Assemble project'
            )}
          </button>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}

      {!artifact && !busy && (
        <p className="muted finished-blurb">
          This collects the code you wrote in every step into one project, then writes a README
          for it{' '}
          <span className="nowrap">— and the deployment config, if it needs any.</span>
        </p>
      )}

      {artifact && (
        <>
          {completeness && !completeness.complete && (
            <div className="notice warn">
              <strong>
                This project is missing {completeness.missing.length} planned file
                {completeness.missing.length === 1 ? '' : 's'}.
              </strong>{' '}
              The blueprint calls for {completeness.missing.length === 1 ? 'a file' : 'files'} no
              step has produced yet, so what you download will not run as the summary describes.
              Usually this means a step is still unfinished.
              <ul className="finished-missing">
                {completeness.missing.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          )}

          {!artifact.fullyLearnerWritten && artifact.stepsFromReference.length > 0 && (
            <div className="notice warn">
              <strong>
                {artifact.stepsFromReference.length === 1
                  ? 'Step '
                  : 'Steps '}
                {artifact.stepsFromReference.map((i) => i + 1).join(', ')} used the reference
                solution.
              </strong>{' '}
              You have not passed {artifact.stepsFromReference.length === 1 ? 'it' : 'them'} yet, so
              that code is not yours. Finish {artifact.stepsFromReference.length === 1 ? 'it' : 'them'}{' '}
              and rebuild before showing this to anyone.
            </div>
          )}

          <div className="finished-body">
            <nav className="finished-tree" aria-label="Project files">
              <h3>
                {artifact.files.length} file{artifact.files.length === 1 ? '' : 's'}
              </h3>
              <ul>
                {artifact.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`finished-file ${openFile === file.path ? 'active' : ''}`}
                      onClick={() => setOpenFile(openFile === file.path ? null : file.path)}
                    >
                      {file.path}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="finished-preview">
              {selected ? (
                <>
                  <div className="finished-preview-head">
                    <code>{selected.path}</code>
                    <button type="button" className="btn ghost" onClick={() => setOpenFile(null)}>
                      Back to README
                    </button>
                  </div>
                  <pre className="finished-code">
                    <code>{selected.contents}</code>
                  </pre>
                </>
              ) : (
                <div className="prose finished-readme">{renderMarkdown(artifact.readmeMd, 'rm')}</div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'nothing_to_assemble' || err.code === 'nothing_to_export') return err.message;
    if (err.code === 'corrupt_blueprint') return err.message;
    if (err.code === 'budget_exceeded') return err.message;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not assemble this project.';
}
