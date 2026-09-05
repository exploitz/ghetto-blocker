/**
 * http-mitm-proxy logs benign transport errors (socket resets, ALPN mismatches
 * from non-HTTP apps caught by a system-wide proxy, DNS misses, request
 * timeouts) directly via console.* and offers no logger hook to disable it.
 * Wrap console.debug/error to drop that known noise while letting genuine
 * errors - and all of our own logs - through untouched.
 *
 * SHORTCUT: pattern-based suppression of a third-party library's hardcoded
 * logging. Upgrade: fork the library to accept an injectable logger, or swap to
 * one that has one. Trigger: the library changes its messages, or a real error
 * starts getting masked.
 */

// Transport-level error codes that are normal proxy life, not bugs.
const BENIGN_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ERR_SSL_NO_APPLICATION_PROTOCOL', // non-HTTP app negotiated TLS through proxy
  'HPE_INVALID_METHOD', // non-HTTP protocol (e.g. push) parsed as HTTP
  'ERR_HTTP_REQUEST_TIMEOUT',
]);

// The library's error-kind labels and section headers (logged as bare strings).
const BENIGN_LABELS = new Set([
  'CLIENT_TO_PROXY_SOCKET_ERROR',
  'PROXY_TO_CLIENT_SOCKET_ERROR',
  'PROXY_TO_SERVER_SOCKET_ERROR',
  'PROXY_TO_SERVER_REQUEST_ERROR',
  'HTTPS_CLIENT_ERROR',
  'Connection error:',
  'Socket error:',
  'Error getting HTTPs server',
]);

function isBenign(arg: unknown): boolean {
  if (typeof arg === 'string') {
    return BENIGN_LABELS.has(arg) || /socket hang up/i.test(arg);
  }
  if (arg instanceof Error) {
    const code = (arg as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      // Self-connect loop is noise; failing to *listen* on our port is fatal.
      return (arg as NodeJS.ErrnoException).syscall === 'connect';
    }
    if (code && BENIGN_CODES.has(code)) return true;
    return /socket hang up/i.test(arg.message);
  }
  return false;
}

/** Install console filters that mute the proxy library's benign chatter. */
export function installQuietLogging(): void {
  const originalError = console.error.bind(console);
  // console.debug is used by the library only for verbose lifecycle spam
  // ("starting server for ...", "creating SNI context ...") we never want.
  console.debug = (): void => {};
  console.error = (...args: unknown[]): void => {
    // Drop a call only when EVERY argument is benign - so a real error, or any
    // of our own labelled logs (e.g. "[fatal]", a listen EADDRINUSE), survives.
    if (args.length > 0 && args.every(isBenign)) return;
    originalError(...args);
  };
}
