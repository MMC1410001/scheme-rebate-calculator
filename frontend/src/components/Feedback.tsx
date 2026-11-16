import { useRef } from "react";
import { useFocusTrap, type ConfirmRequest, type ToastMsg } from "../hooks/useFeedback";

/** Shared feedback pieces: an error line with Retry, the confirm dialog and the toast (hooks in hooks/useFeedback). */

/** A failure in plain words (from errorText), with Retry where trying again can help. */
export function ErrorBanner({ text, onRetry, onDismiss }: { text: string; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className="error error-banner" role="alert">
      <span>{text}</span>
      <span className="error-banner-actions">
        {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
        {onDismiss && (
          <button type="button" className="btn btn-ghost sm" onClick={onDismiss} aria-label="Dismiss this message">
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
}

/** The in-app confirm (see useConfirm): Cancel has focus first; Escape or a click outside cancels. */
export function ConfirmDialog({ req, onClose }: { req: ConfirmRequest; onClose: (ok: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, true, () => onClose(false));
  return (
    <div className="dl-backdrop" onClick={() => onClose(false)}>
      <div ref={box} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"
           aria-describedby={req.body ? "confirm-body" : undefined} onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{req.title}</h2>
        {req.body && <div id="confirm-body" className="confirm-body">{req.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn" data-autofocus onClick={() => onClose(false)}>Cancel</button>
          <button type="button" className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} onClick={() => onClose(true)}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The toast itself (see useToast). */
export function ToastView({ msg, onClose }: { msg: (ToastMsg & { id: number }) | null; onClose: () => void }) {
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {msg && (
        <div className="toast" key={msg.id}>
          <span>{msg.text}</span>
          {msg.action && (
            <button type="button" className="btn sm btn-on-dark" onClick={() => { msg.action!.run(); onClose(); }}>
              {msg.action.label}
            </button>
          )}
          <button type="button" className="toast-x" aria-label="Close this message" onClick={onClose}>×</button>
        </div>
      )}
    </div>
  );
}
