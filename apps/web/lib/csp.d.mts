/** Types for the plain-.mjs CSP module, which next.config.mjs must import as JS. */
export function appCsp(nonce: string): string;
export function sandboxCsp(origin: string): string;
