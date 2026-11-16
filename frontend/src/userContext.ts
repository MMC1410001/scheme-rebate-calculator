import { createContext, useContext } from "react";
import type { Me } from "./api/client";

/** Who is logged in, for any component (AuthGate in auth.tsx provides it). */
export interface UserState {
  user: Me;
  /** Dealer names (the dealer lists): ADMIN and SCHEME_MANAGER. */
  canSeeDealers: boolean;
  logout: () => void;
  /** Counts the times the same user logged in again after the session ended (what failed meanwhile runs again). */
  relogins: number;
}

const LOCAL: Me = { username: "local", role: "ADMIN", login_required: false };
export const UserContext = createContext<UserState>({ user: LOCAL, canSeeDealers: true, logout: () => {}, relogins: 0 });

export const useUser = () => useContext(UserContext);

/** What this login may edit (backend app/access.py): a scheme and its components (`canEdit(key)`), or, without a key,
 *  product and total figures, V and removing schemes (ADMIN only). */
export function canEditOf(user: Me): (scheme?: string) => boolean {
  if (user.role === "ADMIN") return () => true;
  const own = new Set(user.role === "SCHEME_MANAGER" ? user.edit_schemes ?? [] : []);
  return (scheme?: string) => scheme !== undefined && own.has(scheme);
}

export const useCanEdit = () => canEditOf(useUser().user);
