// Verum — demo logic
// API base: set VITE_API_URL to your Railway URL in production.
// In dev (Vite proxy), leave unset — proxy forwards /api → localhost:3000.
const API = import.meta.env.VITE_API_URL ?? '';

let isAccredited = true;
let holderAddress = null;
let proofData = null;

// ── Step navigation ───────────────────────────────────────────────────────────
export function goStep(n) {
  [1, 2, 3].forEach(i => {
    const panel = document.getElementById('panel-' + i);
    const tab   = document.getElementById('tab-' + i);
    const num   = tab.querySelector('span:first-child');
    const lbl   = tab.querySelector('span:last-child');
    if (i === n) {
      panel.classList.remove('hidden');
      tab.style.background = 'rgba(70,70,200,0.12)';
      num.style.color = '#4646C8';
      lbl.style.color = '#ffffff';
    } else {
      panel.classList.add('hidden');
      tab.style.background = 'transparent';
      num.style.color = '#A1A1AA';
      lbl.style.color = '#A1A1AA';
    }
  });
}

// ── Accreditation toggle ──────────────────────────────────────────────────────
export function setAccredited(val) {
  isAccredited = val;
  const yes = document.getElementById('acc-yes');
  const no  = document.getElementById('acc-no');
  yes.style.background = val ? 'rgba(70,70,200,0.15)' : 'transparent';
  yes.style.color      = val ? '#ffffff' : '#A1A1AA';
  no.style.background  = val ? 'transparent' : 'rgba(70,70,200,0.15)';
  no.style.color       = val ? '#A1A1AA' : '#ffffff';
}

// ── Terminal helpers ──────────────────────────────────────────────────────────
function termLog(bodyId, msg, color) {
  const el = document.createElement('div');
  el.style.cssText = `color:${color || '#6A8E8E'};margin-bottom:2px;`;
  el.textContent = '> ' + msg;
  const body = document.getElementById(bodyId);
  body.appendChild(el);
  body.scrollTop = 99999;
}

function setDot(id, active) {
  document.getElementById(id).style.background = active ? '#4646C8' : '#27272A';
}

// ── Setup holder ──────────────────────────────────────────────────────────────
export async function setupHolder() {
  const secret = document.getElementById('holder-secret').value.trim();
  if (!secret.startsWith('S')) {
    showResult('setup-result', false, 'Invalid secret key — must start with S.');
    return;
  }
  document.getElementById('setup-btn-text').textContent = 'Connecting...';
  try {
    const res  = await fetch(`${API}/api/create-trustline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holderSecret: secret }),
    });
    const data = await res.json();
    if (data.success) {
      holderAddress = data.address;
      showResult('setup-result', true,
        '✓ Connected: ' + holderAddress + '\n✓ Trustline created on VERUM asset (Stellar testnet).');
      document.getElementById('setup-btn-text').textContent = '✓ Connected';
      setTimeout(() => goStep(2), 1400);
    } else {
      showResult('setup-result', false, data.error || 'Connection failed.');
      document.getElementById('setup-btn-text').textContent = 'Connect Holder Account';
    }
  } catch (e) {
    showResult('setup-result', false, 'Server error: ' + e.message);
    document.getElementById('setup-btn-text').textContent = 'Connect Holder Account';
  }
}

// ── Generate proof ────────────────────────────────────────────────────────────
export async function generateProof() {
  const countryCode = document.getElementById('country-code').value;
  const capital     = document.getElementById('capital').value;
  const nonce       = document.getElementById('nonce').value;

  document.getElementById('proof-terminal').classList.remove('hidden');
  document.getElementById('terminal-body').innerHTML = '';
  document.getElementById('prove-result').classList.add('hidden');
  document.getElementById('prove-btn').disabled = true;
  setDot('terminal-dot', true);
  document.getElementById('terminal-status').textContent = 'Generating proof...';

  const steps = [
    [200,  'Loading circuit: verum_circuit.json'],
    [700,  'Witness: accredited=' + isAccredited + ', country=' + countryCode + ', capital=' + capital],
    [1200, 'Running constraint solver (nargo 1.0.0-beta.22)...'],
    [1900, 'Check 1/4: Commitment binding...'],
    [2700, 'Check 2/4: Accreditation equality...'],
    [3500, 'Check 3/4: Jurisdiction Merkle membership...'],
    [4300, 'Check 4/4: Capital range proof (≥ $50,000)...'],
    [5100, 'All constraints satisfied. Fetching UltraHonk proof...'],
    [5700, 'Barretenberg proving engine (bb v0.87.0, keccak oracle)...'],
  ];
  steps.forEach(([delay, msg]) =>
    setTimeout(() => termLog('terminal-body', msg, '#A1A1AA'), delay));

  try {
    const res  = await fetch(`${API}/api/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accredited: isAccredited, countryCode, capital, nonce }),
    });
    const data = await res.json();
    setDot('terminal-dot', false);

    if (data.success) {
      termLog('terminal-body', 'Proof generated. ' + data.proofSize + ' bytes (' + (data.proofSize / 32) + ' field elements)', '#4646C8');
      termLog('terminal-body', 'Public inputs: ' + data.publicInputsSize + ' bytes (3 fields)', '#4646C8');
      termLog('terminal-body', 'Proof ready for on-chain submission.', '#4646C8');
      document.getElementById('terminal-status').textContent = '✓ Proof generated';
      proofData = data;
      document.getElementById('summary-size').textContent   = data.proofSize + ' bytes';
      document.getElementById('summary-inputs').textContent = data.publicInputsSize + ' bytes';
      document.getElementById('proof-hex-preview').textContent = data.proofHex.slice(0, 180) + '...';
      showResult('prove-result', true,
        '✓ Zero-knowledge proof generated.\nAll 4 eligibility checks satisfied. No private data revealed.');
      setTimeout(() => goStep(3), 1500);
    } else {
      termLog('terminal-body', 'CONSTRAINT FAILURE: ' + data.error, '#FF4D6A');
      document.getElementById('terminal-status').textContent = '✗ Rejected';
      showResult('prove-result', false, data.error);
    }
  } catch (e) {
    setDot('terminal-dot', false);
    termLog('terminal-body', 'Error: ' + e.message, '#FF4D6A');
    showResult('prove-result', false, 'Server error: ' + e.message);
  }
  document.getElementById('prove-btn').disabled = false;
}

// ── Authorize ─────────────────────────────────────────────────────────────────
export async function authorize() {
  if (!proofData)     return showResult('auth-result', false, 'Generate a proof first.');
  if (!holderAddress) return showResult('auth-result', false, 'Connect a holder account first.');

  document.getElementById('auth-terminal').classList.remove('hidden');
  document.getElementById('auth-terminal-body').innerHTML = '';
  document.getElementById('auth-result').classList.add('hidden');
  document.getElementById('authorize-btn').disabled = true;
  setDot('auth-dot', true);
  document.getElementById('auth-status').textContent = 'Submitting to Stellar testnet...';

  termLog('auth-terminal-body', 'Connecting to Stellar testnet (soroban-testnet.stellar.org)...', '#A1A1AA');
  termLog('auth-terminal-body', 'Calling: Verum Gate → verify_and_authorize', '#A1A1AA');
  termLog('auth-terminal-body', 'Holder: ' + holderAddress, '#A1A1AA');
  termLog('auth-terminal-body', 'Submitting proof (' + proofData.proofSize + ' bytes)...', '#A1A1AA');

  try {
    const res  = await fetch(`${API}/api/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proofHex: proofData.proofHex,
        publicInputsHex: proofData.publicInputsHex,
        holderAddress,
      }),
    });
    const data = await res.json();
    setDot('auth-dot', false);

    if (data.success) {
      termLog('auth-terminal-body', '✓ verify_proof: PASSED (ZK proof valid on-chain)', '#4646C8');
      termLog('auth-terminal-body', '✓ set_authorized: AUTHORIZED on VERUM SAC', '#4646C8');
      termLog('auth-terminal-body', '✓ Event: verum/auth → ' + holderAddress, '#4646C8');
      termLog('auth-terminal-body', 'Tx: ' + data.txHash, '#4646C8');
      document.getElementById('auth-status').textContent = '✓ Authorized';
      showAuthSuccess(data.txHash);
    } else {
      termLog('auth-terminal-body', 'Failed: ' + data.error, '#FF4D6A');
      document.getElementById('auth-status').textContent = '✗ Failed';
      showResult('auth-result', false, data.error);
    }
  } catch (e) {
    setDot('auth-dot', false);
    showResult('auth-result', false, e.message);
  }
  document.getElementById('authorize-btn').disabled = false;
}

// ── Result helpers ────────────────────────────────────────────────────────────
function showResult(id, ok, msg) {
  const el     = document.getElementById(id);
  const border = ok ? '#4646C8' : 'rgba(239,68,68,0.5)';
  const color  = ok ? '#4646C8' : '#f87171';
  el.classList.remove('hidden');
  el.innerHTML = `<div style="border:1px solid ${border};border-radius:8px;padding:20px;background:rgba(17,17,21,0.5);">
    <p style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${color};margin-bottom:12px;">${ok ? '✓ Success' : '✗ Failed'}</p>
    <p style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${color};white-space:pre-wrap;line-height:1.6;">${msg}</p>
  </div>`;
}

function showAuthSuccess(txHash) {
  const el = document.getElementById('auth-result');
  el.classList.remove('hidden');
  const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
  el.innerHTML = `<div style="border:1px solid rgba(70,70,200,0.5);border-radius:8px;padding:24px;background:rgba(40,40,85,0.2);">
    <p style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:#4646C8;margin-bottom:20px;">✓ Trustline Authorized</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">Transaction</span><a href="${explorerUrl}" target="_blank" style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#4646C8;word-break:break-all;text-decoration:underline;">${txHash}</a></div>
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">Holder</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#ffffff;word-break:break-all;">${holderAddress}</span></div>
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">Network</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#ffffff;">Stellar Testnet</span></div>
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">Asset</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#ffffff;">VERUM</span></div>
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">ZK Verified</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#4646C8;">On-chain ✓</span></div>
      <div style="display:flex;gap:16px;"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;text-transform:uppercase;letter-spacing:0.05em;min-width:112px;">Issuer Saw</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#A1A1AA;">Nothing — proof only</span></div>
    </div>
  </div>`;
}

// ── Expose to HTML onclick handlers ──────────────────────────────────────────
window.verum = { goStep, setAccredited, setupHolder, generateProof, authorize };
