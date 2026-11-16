import { useEffect, useState } from "react";

/** The first load. The API takes about a minute to warm up after a restart and queues requests meanwhile, so after
 *  a few seconds this says so, instead of a bare "Loading" that looks like a hang (or "0 schemes", which looks
 *  broken). */
export function StartingUp({ waking }: { waking: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="loading-months" role="status" aria-live="polite">
      <div className="lm-bar"><i /></div>
      <p className="hint">{waking ? "The server is starting up. Trying again by itself…" : "Loading schemes…"}</p>
      {(slow || waking) && (
        <p className="hint lm-note">
          After a restart the server reads the month's data first, which takes about a minute. The figures appear here
          as soon as it is ready; there is no need to reload the page.
        </p>
      )}
    </div>
  );
}
