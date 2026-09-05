// Minimal typing for the node-forge surface leaf-keys.ts uses (no @types/node-forge dependency).
declare module 'node-forge' {
  interface RsaPrivateKey { n: unknown; e: unknown; d: unknown }
  interface RsaPublicKey { n: unknown; e: unknown }
  interface RsaKeyPair { privateKey: RsaPrivateKey; publicKey: RsaPublicKey }
  interface Rsa {
    generateKeyPair(bits: number): RsaKeyPair;
    generateKeyPair(options: { bits: number }, callback: (err: Error | null, keys: RsaKeyPair) => void): void;
  }
  interface Pki {
    rsa: Rsa;
    privateKeyFromPem(pem: string): RsaPrivateKey;
    publicKeyFromPem(pem: string): RsaPublicKey;
  }
  const forge: { pki: Pki };
  export default forge;
}
