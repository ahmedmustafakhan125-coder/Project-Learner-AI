/**
 * Server-Sent Events over `fetch`.
 *
 * The browser's built-in `EventSource` is not usable here: it can only issue
 * GET requests and cannot set an Authorization header. Both are non-negotiable
 * — asking a question is a POST carrying a compiled query, and every route is
 * authenticated.
 *
 * Parsing the wire format by hand also keeps the transport swappable. This
 * module is the single place that knows about SSE, so moving to WebSockets for
 * mobile means replacing this file and nothing else.
 */

export interface SSEMessage {
  event: string;
  data: string;
}

export interface SSERequest {
  url: string;
  body: unknown;
  token: string;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;

  constructor(status: number, code: string, message: string, payload: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function* streamSSE(request: SSERequest): AsyncIterable<SSEMessage> {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.token}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(request.body),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  // Errors arrive as ordinary JSON before the stream ever opens.
  if (!response.ok) {
    const payload = await safeJson(response);
    const record = (payload ?? {}) as Record<string, unknown>;
    throw new ApiError(
      response.status,
      typeof record['error'] === 'string' ? record['error'] : 'request_failed',
      typeof record['message'] === 'string' ? record['message'] : response.statusText,
      payload,
    );
  }

  if (!response.body) {
    throw new ApiError(response.status, 'no_body', 'Server returned no stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` matters: a multi-byte character can be split across two
      // network chunks, and decoding each chunk independently corrupts it.
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Normalise CRLF first — some
      // proxies rewrite line endings.
      buffer = buffer.replace(/\r\n/g, '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const parsed = parseEvent(raw);
        if (parsed) yield parsed;

        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Releases the connection when a consumer breaks out of the loop early.
    reader.cancel().catch(() => undefined);
  }
}

function parseEvent(raw: string): SSEMessage | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or comment/keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not data.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
