import { createPortal } from 'react-dom';

import type { NavItem } from '../../lib/navLinks';
import { AccountPanel } from './AccountPanel';
import { NavLinkList } from './SideNav';

/**
 * The sidebar below 860px: a menu button in the bar and a drawer from the
 * left holding the same links, with the account at its foot.
 *
 * The drawer is portalled to <body>. The bar has a backdrop filter, and a
 * filtered ancestor becomes the containing block for `position: fixed` — left
 * inside the bar, the drawer would be clipped to the bar's 68px.
 */

export interface MobileNavProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  items: readonly NavItem[];
  pathname: string | null;
  name: string;
  email: string | null;
  onSignOut: () => void;
}

export function MobileNav({ open, onOpen, onClose, items, pathname, name, email, onSignOut }: MobileNavProps) {
  const drawer = (
    <div className="nav-drawer-backdrop" onClick={onClose}>
      <div
        id="nav-drawer"
        className="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nav-drawer-head">
          <span className="nav-drawer-title">Menu</span>
          <button type="button" className="nav-drawer-close" aria-label="Close menu" onClick={onClose} autoFocus>
            ✕
          </button>
        </div>

        <nav className="nav-drawer-body" aria-label="Main">
          <NavLinkList items={items} pathname={pathname} onNavigate={onClose} />
        </nav>

        <div className="nav-drawer-foot">
          <AccountPanel name={name} email={email} onSignOut={onSignOut} />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className="nav-burger"
        aria-expanded={open}
        aria-controls="nav-drawer"
        aria-label="Open menu"
        onClick={onOpen}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      {open && createPortal(drawer, document.body)}
    </>
  );
}
