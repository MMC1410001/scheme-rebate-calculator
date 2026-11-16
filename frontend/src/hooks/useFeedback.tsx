import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ConfirmDialog, ToastView } from "../components/Feedback";

/** Feedback hooks: an in-app confirm, an Undo toast and a focus trap (their components are in components/Feedback).
 *  Never window.alert / window.confirm: they block the page and cannot be styled or read out properly. */

/** The open traps, newest last. Only the top one handles keys (Escape in a login dialog over a dealer list closes the
 *  login dialog only), and the page scrolls again only when the last one closes, in whatever order they close. */
const traps: object[] = [];
let pageOverflow = "";

/** Keep Tab inside `ref` while `active`, start on the first control (or one marked data-autofocus), and give focus
 *  back to whatever had it when the trap closes. Escape calls `onEscape`. The page behind does not scroll. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  const esc = useRef(onEscape);
  useEffect(() => { esc.current = onEscape; });
  useEffect(() => {
    if (!active) return;
    const me = {};
    if (traps.length === 0) pageOverflow = document.body.style.overflow;
    traps.push(me);
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const focusables = () => [...(box?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((el) => el.offsetParent !== null);
    const initial = box?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0];
    initial?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (traps[traps.length - 1] !== me) return;   // a dialog opened over this one has the keys
      if (e.key === "Escape" && esc.current) { e.stopPropagation(); esc.current(); return; }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (!box?.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = traps.indexOf(me);
      const wasTop = i === traps.length - 1;
      if (i >= 0) traps.splice(i, 1);
      if (traps.length === 0) document.body.style.overflow = pageOverflow;
      // Focus goes back to the opener only when this was the dialog in front; one closing underneath leaves it.
      if (wasTop && opener && document.contains(opener)) opener.focus();
    };
  }, [active, ref]);
}

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** The action removes or replaces work: the confirm button is red. */
  danger?: boolean;
}

/** `const [confirm, dialog] = useConfirm()`; render `dialog` once; `if (await confirm({...})) ...`. */
export function useConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [req, setReq] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((r: ConfirmRequest) => new Promise<boolean>((resolve) => setReq({ ...r, resolve })), []);
  const close = (ok: boolean) => { req?.resolve(ok); setReq(null); };
  const dialog = req ? <ConfirmDialog req={req} onClose={close} /> : null;
  return [confirm, dialog];
}

export interface ToastMsg {
  text: string;
  /** "Undo" and what it does. */
  action?: { label: string; run: () => void };
}

/** One toast at a time at the bottom of the screen: 10 s with an action, 5 s without. */
export function useToast(): [(msg: ToastMsg) => void, ReactNode] {
  const [msg, setMsg] = useState<(ToastMsg & { id: number }) | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: ToastMsg) => {
    window.clearTimeout(timer.current);
    const id = Date.now();
    setMsg({ ...m, id });
    timer.current = window.setTimeout(() => setMsg((cur) => (cur?.id === id ? null : cur)), m.action ? 10_000 : 5_000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const node = <ToastView msg={msg} onClose={() => setMsg(null)} />;
  return [show, node];
}
