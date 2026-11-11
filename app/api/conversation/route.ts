import { authorizeRequest, challengeHeader } from "@/lib/auth";
import { ownerFor, setOwnerCookie } from "@/lib/owner";
import { allTurns, ownsConversation } from "@/lib/memory/store";

export const runtime = "nodejs";

/**
 * The transcript for one conversation, so a reload rebuilds the thread from
 * the server rather than from whatever the browser happened to keep.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.ok) {
    return Response.json(
      { error: auth.description },
      {
        status: auth.status,
        headers:
          auth.status === 401 ? { "WWW-Authenticate": challengeHeader(auth) } : undefined,
      },
    );
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[\w-]{1,64}$/.test(id)) {
    return Response.json({ error: "`id` is missing or malformed." }, { status: 400 });
  }

  const subject = typeof auth.claims?.sub === "string" ? auth.claims.sub : null;
  const { owner, isNew } = ownerFor(request, subject);

  // An unknown id reads as empty rather than 404: a first visit is not an error.
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
  if (isNew) setOwnerCookie(response, owner);
  return response;
}
