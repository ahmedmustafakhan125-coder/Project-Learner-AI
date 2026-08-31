import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Rate limiting.
 *
 * Registered globally with a generous default (100 req/min) that covers read
 * endpoints. Generation and attempt endpoints opt into tighter limits via
 * route-level `config.rateLimit` overrides — see `rateLimitConfig` below.
 *
 * Keyed on the authenticated user ID when present, falling back to the remote
 * IP for unauthenticated probes (health check, pre-flight). This prevents one
 * learner's burst from counting against another's quota.
 *
 * The `hook` option is load-bearing. @fastify/rate-limit defaults to running at
 * `onRequest`, which is BEFORE the `requireAuth` preHandler that populates
 * `request.user` — so a user-aware `keyGenerator` reads `undefined` there and
 * silently degrades to keying every authenticated request by IP. Running at
 * `preHandler` puts the check after auth has resolved. The cost is that the
 * body has already been parsed by the time a request is rejected; that is the
 * right trade for limits that are supposed to be per-user.
 */

const MINUTE = 60_000;

/** Default: read endpoints — generous. */
const READ_LIMIT = 100;

/** Generation endpoints — expensive, tightly limited. */
const GENERATION_LIMIT = 10;

/** Attempt endpoints — moderate; learners submit frequently. */
const ATTEMPT_LIMIT = 30;

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    max: READ_LIMIT,
    timeWindow: MINUTE,
    // After `requireAuth`, so `request.user` is actually populated.
    hook: 'preHandler',
    keyGenerator(request) {
      // Authenticated requests get their own bucket. Unauthenticated ones
      // (health, pre-flight) fall back to IP, which is why `trustProxy` is set
      // on the server — behind a proxy every request otherwise shares one IP
      // and the whole app collapses into a single bucket.
      return request.user?.id ?? request.ip;
    },
    // Return a structured 429 rather than the default plain text.
    errorResponseBuilder(_request, _reply) {
      return {
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please wait before trying again.',
      };
    },
  });
}

/**
 * Route-level rate-limit config objects.
 *
 * Attached to individual routes via the `config` key, which @fastify/rate-limit
 * reads to override the global ceiling for that route.
 */
export const rateLimitConfig = {
  /** Generation endpoints (blueprint, expand): 10 req/min. */
  generation: {
    rateLimit: {
      max: GENERATION_LIMIT,
      timeWindow: MINUTE,
    },
  },
  /** Attempt endpoints (attempt, advance): 30 req/min. */
  attempt: {
    rateLimit: {
      max: ATTEMPT_LIMIT,
      timeWindow: MINUTE,
    },
  },
} as const;
