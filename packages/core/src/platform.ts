import type { LLMRequest } from '@ai-edu/llm';

/**
 * `AbortSignal` is a genuine cross-platform standard — it exists in browsers,
 * Node, and React Native — but its *type* only ships with the DOM lib or
 * @types/node, and this package deliberately compiles with neither. Pulling in
 * the DOM lib to name one type would also unblock `document` and `window`,
 * which is exactly what the portability guard exists to prevent.
 *
 * Deriving it from the LLM request type keeps the guard intact and guarantees
 * we stay structurally identical to what the provider layer accepts.
 */
export type AbortSignalLike = NonNullable<LLMRequest['signal']>;
