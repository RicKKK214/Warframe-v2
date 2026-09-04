import { revokeSession, clearSessionCookieHeader } from '@/lib/auth';
import { jsonOk, sameOrigin, requestIsSecure } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** POST /api/auth/logout — revoke the current session and clear the cookie. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    // Logout is idempotent and harmless; clear the cookie regardless.
    return jsonOk({ loggedOut: true }, { 'Set-Cookie': clearSessionCookieHeader(requestIsSecure(req)) });
  }
  await revokeSession(req);
  return jsonOk({ loggedOut: true }, { 'Set-Cookie': clearSessionCookieHeader(requestIsSecure(req)) });
}
