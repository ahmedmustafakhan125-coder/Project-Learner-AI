'use client';

import { useState, type FormEvent } from 'react';

import { supabase } from '../../lib/supabase';

/**
 * Who is signed in, a way to set a new password, and Sign out. Shared by the
 * account menu on the bar and by the drawer below 860px.
 *
 * The password changes in place on the signed-in session (`auth.updateUser`):
 * no email round trip, so nothing has to be added to Supabase's allowed
 * redirect URLs for it to work locally or in production.
 */

/** Supabase's own floor (`minimum_password_length` in supabase/config.toml). */
export const MIN_PASSWORD_LENGTH = 6;

export interface AccountPanelProps {
  name: string;
  email: string | null;
  onSignOut: () => void;
}

export function AccountPanel({ name, email, onSignOut }: AccountPanelProps) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const closeForm = () => {
    setResetting(false);
    setPassword('');
    setConfirm('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setNote({ ok: false, text: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }
    if (password !== confirm) {
      setNote({ ok: false, text: 'The two passwords do not match.' });
      return;
    }
    if (!supabase) {
      setNote({ ok: false, text: 'Sign-in is not configured here.' });
      return;
    }
    setBusy(true);
    setNote(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setNote({ ok: false, text: error.message });
      return;
    }
    closeForm();
    setNote({ ok: true, text: 'Password updated.' });
  };

  return (
    <div className="nav-account">
      <div className="nav-account-id">
        <span className="nav-account-name">{name}</span>
        {email && <span className="nav-account-email">{email}</span>}
      </div>

      {resetting ? (
        <form className="nav-account-form" onSubmit={(event) => void submit(event)}>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="nav-account-actions">
            <button type="submit" className="nav-account-save" disabled={busy || !password || !confirm}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                closeForm();
                setNote(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="nav-account-row"
          onClick={() => {
            setResetting(true);
            setNote(null);
          }}
        >
          Reset password
        </button>
      )}

      {note && (
        <p className={`nav-account-note ${note.ok ? 'ok' : 'error'}`} role="status">
          {note.text}
        </p>
      )}

      <button type="button" className="btn-signout nav-user-signout" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
