/**
 * leaf-keys.ts -- one RSA key for every host certificate the proxy mints.
 *
 * http-mitm-proxy generates a fresh 2048-bit RSA key pair, in pure JavaScript,
 * for each host it sees for the first time. That costs 60-130 ms per new host
 * and blocks the event loop while it runs. The key itself adds no security:
 * every leaf certificate is signed by the same local CA on the same machine,
 * so sharing one leaf key (what mitmproxy does) loses nothing. We generate one
 * key natively at startup and hand it back whenever the library asks for a
 * leaf key; the CA key generation (async form) is untouched.
 */

import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

type KeyPair = {
  privateKey: ReturnType<typeof forge.pki.privateKeyFromPem>;
  publicKey: ReturnType<typeof forge.pki.publicKeyFromPem>;
};

let shared: KeyPair | null = null;
let installed = false;

/** Create the shared leaf key (native, ~50 ms once) and route the library's sync key requests to it. */
export function installSharedLeafKey(): KeyPair {
  if (shared) return shared;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  shared = {
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
  };
  if (!installed) {
    installed = true;
    const rsa = forge.pki.rsa as unknown as { generateKeyPair: (...args: unknown[]) => unknown };
    const original = rsa.generateKeyPair;
    rsa.generateKeyPair = function patched(this: unknown, ...args: unknown[]) {
      // The leaf-certificate path is the synchronous `generateKeyPair(bits)` call.
      if (args.length === 1 && typeof args[0] === 'number' && shared) return shared;
      return original.apply(this, args);
    };
  }
  return shared;
}
