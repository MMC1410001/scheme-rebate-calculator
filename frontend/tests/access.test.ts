// Who may edit what on screen (src/userContext.ts canEditOf; the server's rules are backend/app/access.py).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canEditOf } from "../src/userContext.ts";

test("an administrator edits every scheme and the product and total figures", () => {
  const can = canEditOf({ username: "boss", role: "ADMIN", login_required: true, edit_schemes: null });
  assert.equal(can("premium"), true);
  assert.equal(can(), true);
});

test("a scheme manager edits its own schemes only, never product or total figures", () => {
  const can = canEditOf({ username: "mira", role: "SCHEME_MANAGER", login_required: true, edit_schemes: ["premium"] });
  assert.equal(can("premium"), true);
  assert.equal(can("luxury"), false);
  assert.equal(can(), false);
});

test("a viewer edits nothing", () => {
  const can = canEditOf({ username: "vera", role: "VIEWER", login_required: true, edit_schemes: [] });
  assert.equal(can("premium"), false);
  assert.equal(can(), false);
});
