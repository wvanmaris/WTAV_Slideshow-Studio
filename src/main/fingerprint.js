'use strict';
// A stable, opaque per-machine fingerprint for the activation seat cap.
//
// The RAW machine id never leaves the machine — only sha256(product + raw) is
// sent, so the server (and its logs) hold an opaque hash, not a hardware id.
//
// Stability matters more than uniqueness here: it must return the SAME value
// across reboots and app updates, or a machine would consume a new seat every
// launch. So it prefers the OS install id (Windows MachineGuid / macOS
// IOPlatformUUID / Linux machine-id) and falls back to hostname + MACs only when
// those cannot be read. Plain Node (no Electron) so it is unit-testable.
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

function fromWindows() {
  const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString();
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/.exec(out);
  return m ? 'win:' + m[1].trim() : '';
}
function fromMac() {
  const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice',
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString();
  const m = /IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
  return m ? 'mac:' + m[1].trim() : '';
}
function fromLinux() {
  const fs = require('fs');
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const v = fs.readFileSync(p, 'utf8').trim(); if (v) return 'lin:' + v; } catch (e) { /* try next */ }
  }
  return '';
}

// hostname + sorted external MACs — always yields something, so a fingerprint is
// never empty even if the OS id cannot be read.
function fallbackId() {
  const ifaces = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(ifaces || {})) {
    for (const ni of (ifaces[name] || [])) {
      if (ni.mac && ni.mac !== '00:00:00:00:00:00' && !ni.internal) macs.push(ni.mac);
    }
  }
  macs.sort();
  return 'fb:' + os.hostname() + ':' + macs.join(',');
}

function rawMachineId() {
  try {
    let id = '';
    if (process.platform === 'win32') id = fromWindows();
    else if (process.platform === 'darwin') id = fromMac();
    else if (process.platform === 'linux') id = fromLinux();
    if (id) return id;
  } catch (e) { /* fall through */ }
  return fallbackId();
}

// The value sent to the server: 64 hex chars, matching its [A-Za-z0-9_-]{8,128}.
function fingerprint(product) {
  return crypto.createHash('sha256')
    .update(String(product || 'wdc') + '\x00' + rawMachineId())
    .digest('hex');
}

module.exports = { fingerprint, rawMachineId, fallbackId };
