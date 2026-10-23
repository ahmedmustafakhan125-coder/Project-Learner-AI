import type { Ref } from 'react';

import { AccountPanel } from './AccountPanel';

/**
 * The signed-in learner at the foot of the sidebar, opening their account
 * above it: name, email, a new password, and Sign out.
 */

export function Chevron() {
  return (
    <svg className="nav-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface UserMenuProps {
  name: string;
  email: string | null;
  open: boolean;
  onToggle: () => void;
  onSignOut: () => void;
  rootRef?: Ref<HTMLDivElement>;
  toggleRef?: Ref<HTMLButtonElement>;
}

export function UserMenu({ name, email, open, onToggle, onSignOut, rootRef, toggleRef }: UserMenuProps) {
  return (
    <div ref={rootRef} className={`nav-user ${open ? 'open' : ''}`}>
      <button
        ref={toggleRef}
        type="button"
        className="nav-user-toggle"
        aria-expanded={open}
        aria-controls="nav-panel-user"
        onClick={onToggle}
      >
        <span className="nav-user-avatar" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="nav-user-name">{name}</span>
        <Chevron />
      </button>

      <div id="nav-panel-user" className="nav-panel nav-panel-user" role="region" aria-label="Account" hidden={!open}>
        {open && (
          <div className="nav-panel-body">
            <AccountPanel name={name} email={email} onSignOut={onSignOut} />
          </div>
        )}
      </div>
    </div>
  );
}
