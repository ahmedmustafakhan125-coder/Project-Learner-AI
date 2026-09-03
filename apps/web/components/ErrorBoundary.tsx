'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Error boundary for the checkpoint / sandbox section.
 *
 * Wraps the CheckpointRunner so a sandbox crash or unhandled error inside the
 * code runner does not take the entire step view down. Instead, the learner
 * sees a friendly message and a "Try again" button that resets the boundary.
 *
 * React error boundaries must be class components — hooks cannot catch render
 * errors. The state is deliberately minimal: either there is an error or there
 * is not.
 */

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for debugging; a production deployment would
    // forward this to an error-reporting service.
    console.error('[ErrorBoundary] sandbox/checkpoint crash:', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="error-boundary" role="alert">
          <p>Something went wrong with the code runner.</p>
          <button className="btn" onClick={this.handleReset} type="button">
            Try again
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}
