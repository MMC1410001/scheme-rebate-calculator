import { Component, type ErrorInfo, type ReactNode } from "react";

/** Catches a failure while drawing a part of the page, so one broken view never blanks the whole app (a bad answer
 *  once threw in the Plan tab and unmounted everything). Shows plain words and a Try again; `resetKey` (the tab)
 *  clears it when the user moves on. The edits live above this boundary (App), so they are kept. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; whole?: boolean },
  { failed: boolean; key?: string }
> {
  state: { failed: boolean; key?: string } = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { failed: boolean; key?: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A view failed to draw", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error error-banner" role="alert">
        <span>
          {this.props.whole
            ? "The page ran into a problem. Reload the page to continue."
            : "This view ran into a problem. Your edits are kept: try again, or open another tab."}
        </span>
        <span className="error-banner-actions">
          <button type="button" className="btn sm"
                  onClick={() => (this.props.whole ? window.location.reload() : this.setState({ failed: false }))}>
            {this.props.whole ? "Reload" : "Try again"}
          </button>
        </span>
      </div>
    );
  }
}
