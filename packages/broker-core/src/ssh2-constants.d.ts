/**
 * ssh2's own lists of what it can negotiate in this runtime (not in @types/ssh2). `SUPPORTED_CIPHER` leaves out
 * ChaCha20-Poly1305 where neither the crypto library nor ssh2's binding provides it — Electron's BoringSSL.
 */
declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    readonly SUPPORTED_KEX: readonly string[];
    readonly SUPPORTED_SERVER_HOST_KEY: readonly string[];
    readonly SUPPORTED_CIPHER: readonly string[];
    readonly SUPPORTED_MAC: readonly string[];
  };
  export default constants;
}
