import { revokeAllSessions, clearSessionCookieHeader, getSessionUser, DbUnavailableError } from '@/lib/auth';
import { jsonError, jsonOk, sameOrigin, requestIsSecure } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** POST /api/auth/logout-all — revoke every session for the logged-in user. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');
  const user = await getSessionUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Log in first.');
  try {
    const count = await revokeAllSessions(user.id);
    return jsonOk(
      { revoked: count },
      { 'Set-Cookie': clearSessionCookieHeader(requestIsSecure(req)) },
    );
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    return jsonError(500, 'LOGOUT_FAILED', 'Could not log out everywhere. Try again.');
  }
}
