'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentKind } from '@ai-edu/core';
import type { FollowUpTurn } from '@ai-edu/api-client';

import { renderMarkdown } from '@/lib/markdown';

/**
 * A private conversation with one specialist.
 *
 * The fan-out answers once and stops. This is where four agents start earning
 * their cost over one: the learner can press the Conceptual Guide on the part
 * they did not follow without the other three re-answering, and the specialist
 * keeps its own angle while it does.
 *
 * Presentational. The page owns the turns and the streaming, because a stream
 * has to survive this component unmounting when the learner switches tabs.
 */

export interface AgentChatProps {
  agent: AgentKind;
  label: string;
  accentColor: string;
  turns: FollowUpTurn[];
  /** Text arriving right now, before it lands as a turn. Null when idle. */
  streamingText: string | null;
  busy: boolean;
  /** Set while the opening answer is still being written — nothing to press on yet. */
  disabled: boolean;
  error: string | null;
  onSend: (question: string) => void;
  onStop: () => void;
}

export function AgentChat({
  agent,
  label,
  accentColor,
  turns,
  streamingText,
  busy,
  disabled,
  error,
  onSend,
  onStop,
}: AgentChatProps) {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);

  // Follow the stream, but only while it is running: yanking the view back down
  // while someone is re-reading an earlier turn is worse than not scrolling.
  useEffect(() => {
    if (!busy || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [busy, streamingText, turns.length]);

  const submit = () => {
    const question = draft.trim();
    if (!question || busy || disabled) return;
    onSend(question);
    setDraft('');
  };

  const hasConversation = turns.length > 0 || streamingText !== null;

  return (
    <section className="agent-chat" aria-label={`Follow up with ${label}`}>
      <header className="agent-chat-head">
        <span className="agent-chat-dot" style={{ backgroundColor: accentColor }} aria-hidden="true" />
        <h3>Continue with {label}</h3>
        {turns.length > 0 && (
          <span className="agent-chat-count">
            {Math.ceil(turns.length / 2)} follow-up{turns.length > 2 ? 's' : ''}
          </span>
        )}
      </header>

      {hasConversation && (
        <div className="agent-chat-log" ref={logRef}>
          {turns.map((turn, i) => (
            <div key={i} className={`chat-turn chat-turn-${turn.role}`}>
              <span className="chat-turn-who">{turn.role === 'user' ? 'You' : label}</span>
              {turn.role === 'user' ? (
                <p className="chat-turn-text">{turn.content}</p>
              ) : (
                <div className="chat-turn-text answer">{renderMarkdown(turn.content, `f${i}`)}</div>
              )}
            </div>
          ))}

          {streamingText !== null && (
            <div className="chat-turn chat-turn-assistant">
              <span className="chat-turn-who">{label}</span>
              {streamingText ? (
                <div className="chat-turn-text answer">
                  {renderMarkdown(streamingText, 'fs')}
                  <span className="caret" aria-hidden="true" />
                </div>
              ) : (
                <p className="loading-line">
                  <span className="loading-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  Thinking…
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      <div className="agent-chat-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            disabled
              ? 'Wait for the answer to finish…'
              : `Ask ${label} to go deeper, or push back…`
          }
          disabled={disabled || busy}
          rows={2}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. This is a chat box, and
            // the question is usually one line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn danger" onClick={onStop}>
            ■ Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={disabled || !draft.trim()}
          >
            Ask {shortLabel(agent)}
          </button>
        )}
      </div>
    </section>
  );
}

/** The button is narrow; the full specialist name does not fit in it. */
function shortLabel(agent: AgentKind): string {
  switch (agent) {
    case 'simple':
      return 'the guide';
    case 'industry':
      return 'the engineer';
    case 'practice':
      return 'the sandbox';
    case 'concepts':
      return 'for takeaways';
  }
}
