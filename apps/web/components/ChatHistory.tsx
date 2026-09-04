'use client';

import { useMemo, useState } from 'react';
import type { ThreadSummary } from '@ai-edu/api-client';

/**
 * The conversation rail.
 *
 * Threads have been written on every fan-out since the beginning; nothing ever
 * read them back, so a learner's answers vanished the moment they asked the
 * next question. This is the rail that makes them navigable, in the place every
 * chat product puts it: pinned to the left edge, newest first, grouped by age.
 *
 * It is deliberately dumb — the page owns loading, selection and deletion, so
 * the rail stays renderable from a cached list while a request is in flight.
 */

export interface ChatHistoryProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  loading: boolean;
  error: string | null;
  /** True while a fan-out is streaming: switching away mid-answer would lose it. */
  busy: boolean;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onDelete: (threadId: string) => void;
  onRetry: () => void;
}

/** Buckets, oldest last. Matches how people actually look for a past chat. */
const BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'] as const;
type Bucket = (typeof BUCKETS)[number];

export function ChatHistory({
  threads,
  activeThreadId,
  loading,
  error,
  busy,
  onSelect,
  onNew,
  onDelete,
  onRetry,
}: ChatHistoryProps) {
  const [filter, setFilter] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? threads.filter((thread) => thread.title.toLowerCase().includes(needle))
      : threads;

    const groups = new Map<Bucket, ThreadSummary[]>();
    for (const thread of matching) {
      const bucket = bucketFor(thread.updatedAt);
      const existing = groups.get(bucket);
      if (existing) existing.push(thread);
      else groups.set(bucket, [thread]);
    }
    return BUCKETS.filter((bucket) => groups.has(bucket)).map(
      (bucket) => [bucket, groups.get(bucket) ?? []] as const,
    );
  }, [threads, filter]);

  return (
    <aside className="history-rail" aria-label="Conversation history">
      <div className="history-rail-head">
        <button type="button" className="history-new-btn" onClick={onNew} disabled={busy}>
          <span aria-hidden="true">＋</span> New conversation
        </button>

        {threads.length > 4 && (
          <input
            type="search"
            className="history-search"
            value={filter}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
      </div>

      <div className="history-rail-body">
        {loading && threads.length === 0 && (
          <div className="history-state">
            <span className="history-spinner" aria-hidden="true" />
            Loading your history…
          </div>
        )}

        {error && (
          <div className="history-state history-state-error">
            <span>{error}</span>
            <button type="button" className="history-retry" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && threads.length === 0 && (
          <div className="history-state">
            <strong className="history-empty-title">No conversations yet</strong>
            Ask your first question and it will be saved here.
          </div>
        )}

        {threads.length > 0 && grouped.length === 0 && (
          <div className="history-state">No conversation matches “{filter.trim()}”.</div>
        )}

        {grouped.map(([bucket, items]) => (
          <section key={bucket} className="history-group">
            <h3 className="history-group-label">{bucket}</h3>
            <ul className="history-list">
              {items.map((thread) => {
                const active = thread.id === activeThreadId;
                return (
                  <li key={thread.id} className={`history-item ${active ? 'active' : ''}`}>
                    <button
                      type="button"
                      className="history-item-open"
                      // Loading another transcript would tear down the stream in
                      // flight, so the rail goes read-only while one is running.
                      disabled={busy && !active}
                      aria-current={active ? 'true' : undefined}
                      title={thread.title}
                      onClick={() => onSelect(thread.id)}
                    >
                      <span className="history-item-title">{thread.title}</span>
                      <span className="history-item-meta">
                        {relativeTime(thread.updatedAt)}
                        {thread.messageCount > 1 && ` · ${thread.messageCount} questions`}
                      </span>
                    </button>

                    {confirmingId === thread.id ? (
                      <span className="history-confirm">
                        <button
                          type="button"
                          className="history-confirm-yes"
                          onClick={() => {
                            setConfirmingId(null);
                            onDelete(thread.id);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="history-confirm-no"
                          onClick={() => setConfirmingId(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="history-item-delete"
                        aria-label={`Delete conversation: ${thread.title}`}
                        disabled={busy}
                        onClick={() => setConfirmingId(thread.id)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Time formatting
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function bucketFor(iso: string): Bucket {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Older';

  // Calendar days, not elapsed hours: something asked at 23:00 yesterday should
  // read as "Yesterday" at 09:00 today, not as "Today".
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - then.getTime()) / DAY_MS);

  if (days < 0) return 'Today';
  if (days < 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

function relativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
