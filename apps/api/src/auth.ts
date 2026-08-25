import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';

/**
 * Authentication.
 *
 * The browser holds a Supabase session and sends its access token as a bearer
 * token. We verify it against Supabase rather than decoding it locally: local
 * decoding would need the JWT secret distributed to every service, and would
 * not notice a session that has since been revoked.
 */

export interface AuthedUser {
  id: string;
  email: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

export async function resolveUser(token: string): Promise<AuthedUser | null> {
  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Fastify preHandler. Rejects with 401 rather than falling through to an
 * anonymous path — every route in this service is per-learner.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthenticated', message: 'Missing bearer token.' });
    return;
  }

  const user = await resolveUser(token);
  if (!user) {
    await reply.code(401).send({ error: 'unauthenticated', message: 'Invalid or expired session.' });
    return;
  }

  request.user = user;
}

/** Narrow `request.user` for handlers that ran behind `requireAuth`. */
export function userOf(request: FastifyRequest): AuthedUser {
  if (!request.user) {
    throw new Error('userOf() called on a route without the requireAuth preHandler');
  }
  return request.user;
}
