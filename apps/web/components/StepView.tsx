'use client';

import { useState } from 'react';
import type { StepContent } from '@ai-edu/api-client';

import { splitFences } from './AgentTabs';

/**
 * One tutorial step.
 *
 * The ordering is the pedagogy: instructions first, then the learner writes the
 * code, and only then the explanation and alternatives. Showing "why this
 * approach" before they have wrestled with the problem wastes the explanation —
 * it lands as trivia instead of as an answer to a question they were asking.
 *
 * So the explanation and alternatives are collapsed by default, with the reason
 * stated rather than hidden.
 */

export function StepView({ step, projectId }: { step: StepContent; projectId: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <article className="step">
      <header>
        <h2>{step.title}</h2>
        {step.objective && <p className="objective">{step.objective}</p>}
      </header>

      <Markdownish text={step.instructionsMd} />

      {step.starterFiles.length > 0 && (
        <section className="starter">
          <h3>Starting files</h3>
          <p className="muted">
            The scaffolding is written for you. The part that matters is marked with a TODO.
          </p>
          {step.starterFiles.map((file) => (
            <div key={file.path} className="file">
              <div className="file-name">{file.path}</div>
              <pre>
                <code>{file.contents}</code>
              </pre>
            </div>
          ))}
        </section>
      )}

      {/* P3 replaces this with the in-browser editor and checkpoint runner. */}
      <section className="notice info">
        <strong>Write this step yourself.</strong> The in-browser editor and automatic
        checking arrive in the next phase — for now, build it in your own editor.
        {step.hintCount > 0 && (
          <div className="muted" style={{ marginTop: 6 }}>
            {step.hintCount} hint{step.hintCount === 1 ? '' : 's'} available once checkpoints ship.
          </div>
        )}
      </section>

      <section className="reveal">
        {!revealed ? (
          <button className="btn" onClick={() => setRevealed(true)}>
            I have written it — explain the approach
          </button>
        ) : (
          <>
            <h3>Why this approach</h3>
            <Markdownish text={step.explanationMd} />

            {step.alternatives.length > 0 && (
              <>
                <h3>What else you could have used</h3>
                <div className="alternatives">
                  {step.alternatives.map((alt) => (
                    <div className="alternative" key={alt.name}>
                      <div className="alt-head">
                        <strong>{alt.name}</strong>
                        <span className="muted"> instead of {alt.insteadOf}</span>
                      </div>
                      <div className="alt-cols">
                        <div>
                          <div className="alt-label good">Pros</div>
                          <ul className="tight">
                            {alt.pros.map((pro) => (
                              <li key={pro}>{pro}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <div className="alt-label bad">Cons</div>
                          <ul className="tight">
                            {alt.cons.map((con) => (
                              <li key={con}>{con}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <div className="when">
                        <strong>Reach for it when:</strong> {alt.whenToUse}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {!revealed && (
          <p className="muted" style={{ marginTop: 8 }}>
            Held back on purpose — the explanation is far more useful once you have
            hit the problem yourself.
          </p>
        )}
      </section>

      <p className="muted">
        Stuck? <a href={`/ask?project=${projectId}`}>Ask about this step</a> — the four
        specialists already know what you are building.
      </p>
    </article>
  );
}

/**
 * Same deliberate non-renderer as the answer tabs: model output is untrusted,
 * and a markdown library with raw-HTML support would be an XSS path. Code
 * fences are separated out; everything else renders as plain text nodes.
 */
function Markdownish({ text }: { text: string }) {
  const blocks = splitFences(text);
  return (
    <div className="answer">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <pre key={i}>
            <code>{block.content}</code>
          </pre>
        ) : (
          <span key={i}>{block.content}</span>
        ),
      )}
    </div>
  );
}
