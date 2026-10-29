import tls from 'node:tls';

// Node trusts only its own built-in list of certificate authorities, not the computer's. On a
// PC where an antivirus web shield, a VPN or a company proxy re-signs secure connections
// (common on Windows), every request from the floor then fails with "fetch failed" while the
// browser works fine. Trusting the computer's own store as well fixes that, and changes
// nothing where the two lists agree. Returns how many certificates it added.
export function trustSystemCertificates(tlsImpl = tls) {
  if (typeof tlsImpl.getCACertificates !== 'function' || typeof tlsImpl.setDefaultCACertificates !== 'function') return 0;
  try {
    const own = tlsImpl.getCACertificates('default');
    const known = new Set(own);
    const extra = tlsImpl.getCACertificates('system').filter((c) => !known.has(c));
    if (extra.length) tlsImpl.setDefaultCACertificates([...own, ...extra]);
    return extra.length;
  } catch {
    return 0;
  }
}

const CERT = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED']);
const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']);
const BLOCKED = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE']);

// Why a request to a price source failed, in plain words and with what to do about it.
// `fetch failed` alone says nothing; the reason is in err.cause.
export function netReason(err) {
  if (err?.rateLimited) return { kind: 'rate-limit', text: 'it is rate-limiting this internet connection (HTTP 429); the floor tries again in a few minutes' };
  const cause = err?.cause?.cause ?? err?.cause ?? err;
  const code = cause?.code || err?.code || '';
  const msg = String(err?.message || '');
  if (CERT.has(code)) return { kind: 'certificate', code, text: `its secure connection was intercepted (${code}): an antivirus web shield, a VPN or a company proxy re-signs it. Turn off the antivirus's HTTPS / web scanning for node.exe, or the VPN, then restart the floor` };
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return { kind: 'clock', code, text: `its certificate looks out of date (${code}): check that this computer's date and time are right` };
  if (DNS.has(code)) return { kind: 'dns', code, text: `its address couldn't be looked up (${code}): no internet, or a filter blocks it` };
  if (BLOCKED.has(code) || err?.name === 'AbortError' || /timed out/i.test(msg)) return { kind: 'blocked', code: code || 'timeout', text: `it didn't answer (${code || 'timed out'}): a firewall, VPN or network filter may block it` };
  const http = msg.match(/HTTP (\d{3})/)?.[1];
  if (http === '403' || http === '401') return { kind: 'refused', code: `HTTP ${http}`, text: `it refused this connection (HTTP ${http}); a VPN or shared address is often the reason` };
  if (http) return { kind: 'http', code: `HTTP ${http}`, text: `it answered with an error (HTTP ${http})` };
  return { kind: 'other', code, text: code ? `${msg} (${code})` : msg || 'unknown error' };
}
