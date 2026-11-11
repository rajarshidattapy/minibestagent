import { randomUUID } from "node:crypto";

/**
 * Who a conversation belongs to.
 *
 * Signed in, that is the token subject, so memory follows the person across
 * browsers and devices. Signed out, it is an opaque id in an httpOnly cookie:
 * it survives a restart and is not readable by script, but it is per-browser.
 * That difference is worth stating plainly in the UI rather than letting
 * someone discover it when their history appears to vanish.
 */

const COOKIE = "mini_owner";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export type Owner = { owner: string; isNew: boolean };

export function ownerFor(request: Request, subject: string | null): Owner {
  // An authenticated subject always wins, so signing in on a new device
  // brings your history with you.
  if (subject) return { owner: `sub:${subject}`, isNew: false };

  const existing = readCookie(request, COOKIE);
  // Only accept a value we could have issued.
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) {
    return { owner: `anon:${existing}`, isNew: false };
  }
  return { owner: `anon:${randomUUID()}`, isNew: true };
}

/**
 * Does this look like an owner key this app could have issued?
 *
 * Used to validate an admin-supplied `?as=` target before it ever reaches a
 * database query: the subject half can be almost anything an IdP issues
 * (`auth0|507f191e810c19729de860ea`, an email, a UUID), so this only rules
 * out control characters and whitespace rather than guessing a strict shape.
 */
export function isValidOwnerKey(value: string): boolean {
  return /^(sub|anon):[\x21-\x7e]{1,190}$/.test(value);
}

export function setOwnerCookie(response: Response, owner: string): void {
  const id = owner.replace(/^anon:/, "");
  response.headers.append(
    "Set-Cookie",
    [
      `${COOKIE}=${id}`,
      "Path=/",
      `Max-Age=${ONE_YEAR_SECONDS}`,
      // Not script-readable, so an XSS bug cannot lift someone's history id.
      "HttpOnly",
      "SameSite=Lax",
      ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    ].join("; "),
  );
}
