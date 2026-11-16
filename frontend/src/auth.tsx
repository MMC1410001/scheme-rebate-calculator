import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorText, onSessionEnded, type Me } from "./api/client";
import { useFocusTrap } from "./hooks/useFeedback";
import { UserContext, useUser } from "./userContext";

/** Login (backend app/auth.py; user's choice, 5 Nov 2026: as in an earlier internal app).
 *
 *  AuthGate asks the server who is logged in. Nobody: the login screen. A session that ends while working (8 hours,
 *  or a password change) opens the login as a dialog over the page, so unsaved edits stay where they are. Roles:
 *  ADMIN may do everything; SCHEME_MANAGER edits only its own schemes and changes only its own versions; VIEWER sees
 *  everything but the dealer lists and changes nothing. */


function LoginForm({ onDone, ended }: { onDone: (me: Me) => void; ended?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError("Enter your username and password."); return; }
    setBusy(true);
    setError(null);
    api.login(username.trim(), password)
      .then((me) => { setPassword(""); onDone(me); })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="login-form" onSubmit={submit} noValidate>
      <h2 id="login-title">{ended ? "Please log in again" : "Log in"}</h2>
      {ended && <p className="hint">Your session has ended. Your unsaved edits are still here.</p>}
      <label>
        <span>Username</span>
        <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)}
               data-autofocus disabled={busy} maxLength={200} />
      </label>
      <label>
        <span>Password</span>
        <input type="password" autoComplete="current-password" value={password}
               onChange={(e) => setPassword(e.target.value)} disabled={busy} maxLength={200} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
    </form>
  );
}

function ExpiredDialog({ onDone }: { onDone: (me: Me) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, true);
  return (
    <div className="dl-backdrop">
      <div ref={box} className="confirm-dialog login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <LoginForm onDone={onDone} ended />
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [ended, setEnded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Bumped when someone else logs in over an ended session: the screen starts afresh, so nothing the previous user
   *  had open (edits, a dealer list, an opened version) stays in front of the new one. */
  const [generation, setGeneration] = useState(0);
  /** Bumped when the same user logs in again over an ended session: the page runs again what failed meanwhile. */
  const [relogins, setRelogins] = useState(0);

  useEffect(() => {
    let live = true;
    api.me()
      .then((me) => { if (live) { setUser(me); setProblem(null); } })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) { setUser(null); setProblem(null); return; }
        setProblem(errorText(e));
        // The server may still be starting: try again by itself.
        window.setTimeout(() => live && setAttempt((n) => n + 1), 5000);
      });
    return () => { live = false; };
  }, [attempt]);

  useEffect(() => onSessionEnded(() => setEnded(true)), []);

  const logout = () => {
    api.logout().catch(() => { /* the cookie is cleared anyway when it expires */ })
      .finally(() => { setUser(null); setEnded(false); });
  };

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Scheme Performance &amp; Impact</h1>
          {problem
            ? <p className="hint" role="status">{problem} Trying again by itself…</p>
            : <LoginForm onDone={(me) => { setUser(me); setEnded(false); }} />}
        </div>
      </main>
    );
  }
  return (
    <UserContext.Provider value={{ user, canSeeDealers: user.can_see_dealers ?? user.role === "ADMIN", logout, relogins }}>
      <Fragment key={generation}>{children}</Fragment>
      {ended && <ExpiredDialog onDone={(me) => {
        if (me.username !== user.username) setGeneration((n) => n + 1);
        else setRelogins((n) => n + 1);
        setUser(me);
        setEnded(false);
      }} />}
    </UserContext.Provider>
  );
}

/** The user's name and Log out, for the command bar (nothing on a developer machine without login). `confirmLeave`
 *  asks first when logging out would throw away unsaved edits (they live in this browser only). */
export function UserBadge({ confirmLeave }: { confirmLeave?: () => Promise<boolean> }) {
  const { user, logout } = useUser();
  if (!user.login_required) return null;
  return (
    <span className="user-badge">
      <span title={user.role === "VIEWER" ? "Can view everything except dealer lists; edits and saving need another role"
        : user.role === "SCHEME_MANAGER" ? `Edits only: ${(user.edit_schemes ?? []).join(", ") || "no scheme yet"}`
          : "Administrator"}>
        {user.username}{user.role === "VIEWER" ? " · viewer" : user.role === "SCHEME_MANAGER" ? " · scheme manager" : ""}
      </span>
      <button type="button" className="btn btn-ghost sm" onClick={async () => { if (!confirmLeave || await confirmLeave()) logout(); }}>
        Log out
      </button>
    </span>
  );
}
