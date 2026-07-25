'use strict';
// Licence keys — creation and verification.
//
// Design constraints that drove this:
//   * Show-control machines are often on isolated networks. Verification is
//     therefore OFFLINE: a key carries its own signature and the app checks it
//     against a public key compiled in. No server is needed to RUN.
//   * A key expires, so an online renewal can be required periodically without
//     the app ever depending on the network at the moment it matters.
//   * The private key never ships. It signs keys on Walter's machine only.
//
// Format:  WTAV-<base64url(payload)>.<base64url(signature)>
// Payload: compact JSON {v,p,e,i,x,t} — version, product, email, issued,
//          expires, type. Short field names keep the key short enough to paste.
//          Two optional fields were added later, present only when they apply:
//            s  — seats: how many machines may ACTIVATE this key. Enforced by the
//                 activation server, never by the app: an offline machine cannot
//                 know how many others exist, and the whole design runs offline.
//            mj — major-version ceiling for a FIXED-INSTALL licence. The key
//                 validates on any build whose major version is <= mj and stops
//                 at the next major. Absent = no ceiling (a roaming licence, kept
//                 current by renewal instead).
//
// Ed25519 via Node's built-in crypto: no dependency, small keys, short
// signatures. RSA would make the key string three times longer to no benefit.

const crypto = require('crypto');

const KEY_PREFIX = 'WTAV';
const PRODUCT = 'wdc';            // this app; other WTAV tools get their own
const FORMAT_VERSION = 1;

const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// opts: {email, days, type, product, issuedAt, seats, major}
//   type  — 'roaming' | 'fixed' for the two commercial tiers, or the legacy
//           'free' | 'perpetual' | 'subscription'. It is descriptive only.
//   seats — machines that may activate (2 for roaming, 1 for fixed). Optional.
//   major — the major version this FIXED key is valid through. Optional; set it
//           only for fixed installs. Roaming keys omit it and never expire on a
//           version bump.
function createLicense(privateKeyPem, opts) {
  const o = opts || {};
  const email = String(o.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');
  const issued = Number(o.issuedAt) || Date.now();
  const type = o.type || 'free';
  // days <= 0 means no expiry — the escape hatch for when the renewal service
  // is ever retired, so existing installs do not all die with it.
  const days = o.days === undefined ? 35 : Number(o.days);
  const payload = {
    v: FORMAT_VERSION,
    p: o.product || PRODUCT,
    e: email,
    i: issued,
    x: days > 0 ? issued + days * 86400000 : 0,
    t: type,
  };
  // Optional fields are added only when specified, so a key issued without them
  // stays byte-identical to what the original tool produced.
  if (o.seats !== undefined && o.seats !== null && o.seats !== '') payload.s = Number(o.seats);
  if (o.major !== undefined && o.major !== null && o.major !== '') payload.mj = Number(o.major);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, body, crypto.createPrivateKey(privateKeyPem));
  return KEY_PREFIX + '-' + b64u.enc(body) + '.' + b64u.enc(sig);
}

// Returns {ok, reason, payload}. Never throws on malformed input — a user will
// paste whitespace, half a key, or an email by mistake.
//
// publicKeyPem may be ONE key or an ARRAY. Two keys are used deliberately:
//   * the ISSUING key signs new licences and never leaves Walter's machine;
//   * the RENEWAL key sits on the web server and may only extend the expiry of
//     a licence that already exists, for the same address.
// Splitting them limits the damage if the server is ever compromised: an
// attacker could extend licences already in the wild, but could not mint one for
// an arbitrary address, and the renewal key can be dropped in an app update
// without invalidating anybody's licence.
function verifyLicense(publicKeyPem, key, opts) {
  const now = (opts && opts.now) || Date.now();
  const graceDays = (opts && opts.graceDays !== undefined) ? Number(opts.graceDays) : 0;
  const s = String(key || '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (!s.startsWith(KEY_PREFIX + '-')) return { ok: false, reason: 'not-a-key' };
  const parts = s.slice(KEY_PREFIX.length + 1).split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  let body, sig, payload;
  try {
    body = b64u.dec(parts[0]);
    sig = b64u.dec(parts[1]);
    payload = JSON.parse(body.toString('utf8'));
  } catch (e) { return { ok: false, reason: 'malformed' }; }

  const pems = Array.isArray(publicKeyPem) ? publicKeyPem.filter(Boolean) : [publicKeyPem];
  let good = false, signedBy = '';
  for (let i = 0; i < pems.length; i++) {
    try {
      if (crypto.verify(null, body, crypto.createPublicKey(pems[i]), sig)) {
        good = true; signedBy = i === 0 ? 'issuer' : 'renewal'; break;
      }
    } catch (e) { /* a malformed PEM in the list must not mask a valid signature */ }
  }
  if (!good) return { ok: false, reason: 'bad-signature' };

  if (payload.v !== FORMAT_VERSION) return { ok: false, reason: 'unsupported-version', payload };
  if (payload.p && opts && opts.product && payload.p !== opts.product) {
    return { ok: false, reason: 'wrong-product', payload };
  }

  // A FIXED-INSTALL licence carries a major-version ceiling: it is perpetual, but
  // only for the major it was sold under. A build newer than that is a paid
  // upgrade, so the key must NOT unlock it — the app falls back to demo instead.
  // Only checked when the caller passes appMajor and the key carries mj, so
  // roaming keys and every key issued before this field existed are unaffected.
  if (payload.mj != null && opts && opts.appMajor != null && Number(opts.appMajor) > Number(payload.mj)) {
    return { ok: false, reason: 'version-exceeded', payload, signedBy };
  }

  if (payload.x) {
    const graceMs = graceDays * 86400000;
    if (now > payload.x + graceMs) return { ok: false, reason: 'expired', payload, signedBy };
    if (now > payload.x) return { ok: true, reason: 'grace', payload, expiresAt: payload.x, signedBy };
  }
  return { ok: true, reason: 'valid', payload, expiresAt: payload.x || 0, signedBy };
}

// Days left, negative once past expiry. null when the key never expires.
function daysLeft(payload, now) {
  if (!payload || !payload.x) return null;
  return Math.ceil((payload.x - (now || Date.now())) / 86400000);
}

module.exports = { generateKeypair, createLicense, verifyLicense, daysLeft, KEY_PREFIX, PRODUCT, FORMAT_VERSION };
