import type { JWTPayload } from "jose";

/**
 * Role-based permission control, layered on top of the OAuth2/JWT verification
 * in lib/auth.ts. Authentication answers "who is this"; this module answers
 * "what are they allowed to do" - a distinct question, checked separately on
 * every route.
 *
 * Roles and permissions are read from the verified token's own claims, so
 * there is no second place to keep them in sync. Different identity providers
 * put them in different claims (a plain `roles` array, Auth0's namespaced
 * custom claims, Keycloak's `realm_access.roles`, a space-delimited `scope`),
 * so the claim location is configurable rather than assumed.
 */

export type Permission =
  | "chat:send"
  | "chat:read"
  | "admin:read_any"
  | "admin:view_stats";

export type Role = "user" | "readonly" | "admin";

const ALL_PERMISSIONS: readonly Permission[] = [
  "chat:send",
  "chat:read",
  "admin:read_any",
  "admin:view_stats",
];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // A signed-in principal with no role claims the app recognises still gets
  // ordinary chat access - most OIDC setups never configure custom roles,
  // and failing those users down to nothing would make RBAC a trap for
  // everyone who does not opt in, rather than a control for those who do.
  user: ["chat:send", "chat:read"],
  // Can see history but not spend tokens sending new messages - the
  // restriction case, not just the elevation case, so "a role can take
  // permissions away" is demonstrated and tested, not only "roles can grant
  // extra access".
  readonly: ["chat:read"],
  admin: ["chat:send", "chat:read", "admin:read_any", "admin:view_stats"],
};

const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_PERMISSIONS));
const KNOWN_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

/**
 * Resolve a claim path against the claims object.
 *
 * A literal top-level key is tried first, and only then a dot-separated
 * nested path. That order matters: namespaced custom claims (Auth0's
 * convention, `"https://myapp.example/roles"`) are themselves top-level keys
 * that happen to contain dots, and splitting one on "." the way a genuinely
 * nested path like "realm_access.roles" needs to be split would look up
 * segments like "https://myapp" and "example/roles" and find nothing.
 */
function resolvePath(claims: JWTPayload, path: string): unknown {
  const direct = (claims as Record<string, unknown>)[path];
  if (direct !== undefined) return direct;

  let value: unknown = claims;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** A claim value as a flat list of strings, whatever shape the IdP used. */
function flatten(value: unknown): string[] {
  if (typeof value === "string") {
    // Covers both a scope-style space-delimited string and a plain CSV.
    return value.split(/[\s,]+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flatten(entry));
  }
  return [];
}

/** Every claim path checked for roles or permissions, in order. */
function roleClaimPaths(): string[] {
  const configured = process.env.OIDC_ROLES_CLAIM?.trim();
  return [
    ...(configured ? [configured] : []),
    "roles",
    "role",
    "permissions",
    "scope",
    "realm_access.roles", // Keycloak
    "cognito:groups", // Amazon Cognito
  ];
}

type Resolved = { roles: Role[]; permissions: Permission[] };

/**
 * Pull every role and permission string out of the claims, from whichever
 * claim the issuer actually used.
 *
 * A role claim is trusted outright when it parses: the issuer is actively
 * managing access for this app, so "readonly" must mean exactly readonly,
 * not readonly-plus-the-default. The default floor below applies only when
 * nothing recognisable was found at all.
 */
function resolveClaims(claims: JWTPayload): Resolved {
  const roles = new Set<Role>();
  const permissions = new Set<Permission>();

  for (const path of roleClaimPaths()) {
    for (const token of flatten(resolvePath(claims, path))) {
      const value = token.toLowerCase();
      if (KNOWN_ROLES.has(value)) roles.add(value as Role);
      if (KNOWN_PERMISSIONS.has(value)) permissions.add(value as Permission);
    }
  }

  return { roles: [...roles], permissions: [...permissions] };
}

/**
 * The permissions a request carries.
 *
 * `claims` is `null` exactly when auth is disabled (local dev, or
 * AUTH_OPTIONAL=true) - there is no principal to read roles from, so the
 * floor default applies rather than anything elevated. Running open in
 * production never implies admin access; it implies the same base role an
 * ordinary signed-in user gets.
 */
export function permissionsFor(claims: JWTPayload | null): Set<Permission> {
  if (!claims) return new Set(ROLE_PERMISSIONS.user);

  const { roles, permissions } = resolveClaims(claims);
  if (roles.length === 0 && permissions.length === 0) {
    return new Set(ROLE_PERMISSIONS.user);
  }

  const resolved = new Set<Permission>(permissions);
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) resolved.add(permission);
  }
  return resolved;
}

export function hasPermission(claims: JWTPayload | null, permission: Permission): boolean {
  return permissionsFor(claims).has(permission);
}

export type PermissionFailure = {
  status: 403;
  error: string;
};

/** The 403 to return when a permission is missing, or null when it is held. */
export function requirePermission(
  claims: JWTPayload | null,
  permission: Permission,
): PermissionFailure | null {
  if (hasPermission(claims, permission)) return null;
  return {
    status: 403,
    error: `This action requires the "${permission}" permission.`,
  };
}

/** Who this principal is, for logging - never used in an access decision. */
export function describePrincipal(claims: JWTPayload | null): string {
  if (!claims) return "anonymous";
  const sub = typeof claims.sub === "string" ? claims.sub : "unknown";
  const { roles } = resolveClaims(claims);
  return `${sub} [${roles.length ? roles.join(",") : "user"}]`;
}
