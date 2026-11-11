import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describePrincipal,
  hasPermission,
  permissionsFor,
  requirePermission,
} from "./rbac.ts";
import type { JWTPayload } from "jose";

beforeEach(() => {
  delete process.env.OIDC_ROLES_CLAIM;
});

const claims = (extra: Partial<JWTPayload>): JWTPayload => ({
  sub: "user-1",
  iss: "https://issuer.example",
  aud: "https://api.example",
  ...extra,
});

// --- the floor default -----------------------------------------------------

test("auth disabled (no principal at all) gets the base user role, never admin", () => {
  // claims is null exactly when there is no verified token - local dev or
  // AUTH_OPTIONAL=true. Running open must never imply elevated access.
  const perms = permissionsFor(null);
  assert.ok(perms.has("chat:send"));
  assert.ok(perms.has("chat:read"));
  assert.ok(!perms.has("admin:read_any"));
  assert.ok(!perms.has("admin:view_stats"));
});

test("a signed-in token with no roles claim at all gets the same base role", () => {
  // The overwhelmingly common case: an IdP with no custom roles configured.
  // RBAC must not turn into "every token with no roles claim is denied".
  const perms = permissionsFor(claims({}));
  assert.ok(perms.has("chat:send"));
  assert.ok(perms.has("chat:read"));
  assert.ok(!perms.has("admin:read_any"));
});

test("garbage in the roles claim also falls back to the base role", () => {
  const perms = permissionsFor(claims({ roles: ["not-a-real-role", "", 42] } as JWTPayload));
  assert.deepEqual([...perms].sort(), ["chat:read", "chat:send"]);
});

// --- explicit roles, from every claim shape an IdP might use ---------------

test("a plain roles array is honoured", () => {
  assert.equal(hasPermission(claims({ roles: ["admin"] } as JWTPayload), "admin:view_stats"), true);
});

test("a space-delimited scope string is parsed like OAuth2 scopes", () => {
  const perms = permissionsFor(claims({ scope: "openid profile admin" } as JWTPayload));
  assert.ok(perms.has("admin:read_any"));
});

test("Keycloak's nested realm_access.roles is read", () => {
  const perms = permissionsFor(
    claims({ realm_access: { roles: ["offline_access", "admin"] } } as JWTPayload),
  );
  assert.ok(perms.has("admin:view_stats"));
});

test("Cognito's cognito:groups is read", () => {
  const perms = permissionsFor(claims({ "cognito:groups": ["readonly"] } as JWTPayload));
  assert.deepEqual([...perms], ["chat:read"]);
});

test("a configurable custom claim path is checked first", () => {
  process.env.OIDC_ROLES_CLAIM = "https://myapp.example/roles";
  const perms = permissionsFor(
    claims({ "https://myapp.example/roles": ["admin"] } as JWTPayload),
  );
  assert.ok(perms.has("admin:read_any"));
});

test("a namespaced claim key containing dots is matched directly, not split on them", () => {
  // Auth0's convention for custom claims is a full URL used as the key, e.g.
  // "https://myapp.example/roles" - that key itself contains dots and must
  // not be mistaken for a nested path like "realm_access.roles".
  process.env.OIDC_ROLES_CLAIM = "https://myapp.example/roles";
  const perms = permissionsFor(
    claims({
      "https://myapp.example/roles": ["admin"],
      // A decoy that a naive dot-split could wrongly resolve into instead.
      "https://myapp": { "example/roles": ["readonly"] },
    } as unknown as JWTPayload),
  );
  assert.ok(perms.has("admin:read_any"), "the literal namespaced key must win");
  assert.ok(perms.has("chat:send"), "the admin role grants chat:send too");
  assert.ok(
    !(perms.has("chat:read") && perms.size === 1),
    "must not have resolved to the readonly decoy instead",
  );
});

test("a permissions claim can grant fine-grained access directly, without a role", () => {
  // Some IdPs (e.g. Auth0 RBAC) issue permission strings directly rather than
  // role names. A direct grant does not add the base-role floor on top.
  const perms = permissionsFor(claims({ permissions: ["admin:view_stats"] } as JWTPayload));
  assert.deepEqual([...perms], ["admin:view_stats"]);
  assert.ok(!perms.has("chat:send"), "a direct grant must not imply the base role too");
});

// --- the restriction case, not just elevation ------------------------------

test('"readonly" removes chat:send rather than adding to it', () => {
  const perms = permissionsFor(claims({ roles: ["readonly"] } as JWTPayload));
  assert.deepEqual([...perms], ["chat:read"]);
  assert.equal(hasPermission(claims({ roles: ["readonly"] } as JWTPayload), "chat:send"), false);
});

// --- admin is a strict superset --------------------------------------------

test("admin holds every permission", () => {
  const perms = permissionsFor(claims({ roles: ["admin"] } as JWTPayload));
  assert.deepEqual(
    [...perms].sort(),
    ["admin:read_any", "admin:view_stats", "chat:read", "chat:send"],
  );
});

test("multiple roles union their permissions", () => {
  const perms = permissionsFor(claims({ roles: ["readonly", "admin:read_any"] } as JWTPayload));
  // "readonly" is a role; "admin:read_any" here is a direct permission string,
  // not a role - both forms resolve from the same claim.
  assert.ok(perms.has("chat:read"));
  assert.ok(perms.has("admin:read_any"));
  assert.ok(!perms.has("chat:send"));
});

// --- requirePermission / describePrincipal ---------------------------------

test("requirePermission is null when held, a 403 shape when not", () => {
  assert.equal(requirePermission(claims({ roles: ["admin"] } as JWTPayload), "admin:view_stats"), null);

  const denied = requirePermission(claims({}), "admin:view_stats");
  assert.equal(denied?.status, 403);
  assert.match(denied!.error, /admin:view_stats/);
});

test("describePrincipal never throws and never reveals more than sub + role", () => {
  assert.equal(describePrincipal(null), "anonymous");
  assert.match(describePrincipal(claims({ roles: ["admin"] } as JWTPayload)), /^user-1 \[admin\]$/);
  assert.match(describePrincipal(claims({})), /^user-1 \[user\]$/);
});
