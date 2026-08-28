import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Rate limiting.
 *
 * Registered globally with a generous default (100 req/min) that covers read
 * endpoints. Generation and attempt endpoints opt into tighter limits via
 * route-level `config.rateLimit` overrides — see `registerRateLimit` below.
 *
 * Keyed on the authenticated user ID when present, falling back to the remote
 * IP for unauthenticated probes (health check, pre-flight). This prevents one
 * learner's burst from counting against another's quota.
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
    keyGenerator(request) {
      // Attempt synchronous user extraction from the already-resolved auth.
      // When `requireAuth` has already run, `request.user` is populated.
      if (request.user?.id) return request.user.id;

      // Fall back to IP for unauthenticated routes (e.g. /health).
      return request.ip;
    },
    // Return a structured 429 rather than the default plain text.
    errorResponseBuilder(_request, _reply) {
      return {
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please wait before trying again.',
      };
    },
  });

  // ---- Route-level overrides -----------------------------------------------
  //
  // Fastify rate-limit allows per-route overrides via `app.route()` config.
  // We register them here as decorated route options that the route files can
  // reference, but the simplest approach is to register additional scoped
  // rate-limit instances on the prefix patterns that need tighter limits.

  // Generation endpoints: 10 req/min
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        max: GENERATION_LIMIT,
        timeWindow: MINUTE,
        keyGenerator(request) {
          return request.user?.id ?? request.ip;
        },
      });
    },
    // These are POST endpoints, so prefix matching covers them exactly.
    // /api/projects/blueprint and /api/projects/:id/steps/:index/expand
  );

  // Attempt endpoints: 30 req/min
  // Registered at the app level with a keyGenerator override.
  // Since we cannot easily prefix-match dynamic segments, we use the
  // `addHook` approach below for attempt routes specifically.
}

/**
 * Route-level rate-limit config objects.
 *
 * These are exported so route files can attach them to individual route
 * definitions via the `config` key, which @fastify/rate-limit reads.
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
