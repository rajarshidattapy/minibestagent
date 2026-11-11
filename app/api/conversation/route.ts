import { authorizeRequest, challengeHeader } from "@/lib/auth";
import { isValidOwnerKey, ownerFor, setOwnerCookie } from "@/lib/owner";
import { describePrincipal, requirePermission } from "@/lib/rbac";
import { allTurns, ownsConversation } from "@/lib/memory/store";
import { metrics, withHttpMetrics } from "@/lib/metrics";

export const runtime = "nodejs";

/**
 * The transcript for one conversation, so a reload rebuilds the thread from
 * the server rather than from whatever the browser happened to keep.
 */
export async function GET(request: Request) {
  return withHttpMetrics(request, "/api/conversation", () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const m = metrics();

  const auth = await authorizeRequest(request);
  if (!auth.ok) {
    m.authFailuresTotal.inc({ reason: auth.error ?? "no_token" });
    return Response.json(
      { error: auth.description },
      {
        status: auth.status,
        headers:
          auth.status === 401 ? { "WWW-Authenticate": challengeHeader(auth) } : undefined,
      },
    );
  }

  // "readonly" can still reach this endpoint for their own history; neither
  // role can read someone else's without the separate admin check below.
  const forbidden = requirePermission(auth.claims, "chat:read");
  if (forbidden) {
    m.authFailuresTotal.inc({ reason: "forbidden:chat:read" });
    return Response.json({ error: forbidden.error }, { status: forbidden.status });
  }

  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (!id || !/^[\w-]{1,64}$/.test(id)) {
    return Response.json({ error: "`id` is missing or malformed." }, { status: 400 });
  }

  const subject = typeof auth.claims?.sub === "string" ? auth.claims.sub : null;
  const { owner: ownOwner, isNew } = ownerFor(request, subject);

  // Support/ops reading a named user's conversation by their owner key - a
  // distinct, more sensitive action than reading your own, so it needs its
  // own permission rather than riding on chat:read.
  const impersonate = params.get("as");
  let owner = ownOwner;
  if (impersonate !== null) {
    const elevated = requirePermission(auth.claims, "admin:read_any");
    if (elevated) {
      m.authFailuresTotal.inc({ reason: "forbidden:admin:read_any" });
      return Response.json({ error: elevated.error }, { status: elevated.status });
    }
    if (!isValidOwnerKey(impersonate)) {
      return Response.json({ error: "`as` is not a recognisable owner key." }, { status: 400 });
    }
    owner = impersonate;
    // Reading someone else's conversation is exactly the kind of action an
    // audit trail exists for. This is a server log, not persisted storage -
    // see DESIGN.md for the upgrade to a durable admin audit log.
    console.warn(
      `[admin] ${describePrincipal(auth.claims)} read conversation "${id}" as ${owner}`,
    );
  }

  // An unknown id reads as empty rather than 404: a first visit is not an
  // error for your own history. For an impersonated read, "empty" and "not
  // yours" are the same observable outcome either way, so this does not leak
  // which conversations exist.
  if (!ownsConversation(id, owner)) {
    return Response.json({ turns: [] });
  }

  const turns = allTurns(id).map((turn) => ({
    id: String(turn.id),
    role: turn.role,
    ts: new Date(turn.ts).toISOString(),
    text: turn.text,
    content: turn.content,
  }));

  const response = Response.json({ turns });
  // Never set the caller's own session cookie while looking at someone else's data.
  if (isNew && impersonate === null) setOwnerCookie(response, owner);
  return response;
}
