require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  Keypair, Networks, rpc, TransactionBuilder,
  BASE_FEE, xdr, Address, Contract,
} = require('@stellar/stellar-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ALICE_SECRET       = process.env.ALICE_SECRET;
const GATE_CONTRACT      = process.env.GATE_CONTRACT;
const SAC_CONTRACT       = process.env.SAC_CONTRACT;
const RPC_URL            = process.env.RPC_URL;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE;
const CIRCUIT_DIR   = process.env.CIRCUIT_DIR
  || path.join(process.env.HOME, 'verum/verum_circuit');
const HASHER_DIR    = process.env.HASHER_DIR
  || path.join(process.env.HOME, 'verum/commitment_hasher');
const BB_087_PATH   = process.env.BB_087_PATH
  || path.join(process.env.HOME, 'bb_v087/bb');
const NARGO_BIN_DIR = path.join(process.env.HOME, '.nargo/bin');
const NARGO_BIN_PATH     = path.join(NARGO_BIN_DIR, 'nargo');

// Toolchain versions — see handover note. Witness gen for on-chain-compatible
// proofs requires beta.9; everyday compilation/constraint-checking uses beta.22.
// These MUST match the versions used to compile the deployed verifier contract.
//
// IMPORTANT: switching via `noirup` re-downloads the binary over the network
// on every call (~7-12 minutes per switch, confirmed empirically). That is
// not viable per-request. Both versions are pre-cached locally once via
// `noirup`, then switched between with a plain local file copy (~instant).
// See ~/.nargo-versions/{beta22,beta9}/nargo — populate these once manually:
//   cp ~/.nargo/bin/nargo ~/.nargo-versions/beta22/nargo   (while beta.22 active)
//   noirup -v 1.0.0-beta.9
//   cp ~/.nargo/bin/nargo ~/.nargo-versions/beta9/nargo
//   noirup -v 1.0.0-beta.22   (restore default before starting the server)
const NARGO_VERSIONS_DIR    = process.env.NARGO_VERSIONS_DIR || path.join(process.env.HOME, '.nargo-versions');
const NARGO_WITNESS_BIN     = path.join(NARGO_VERSIONS_DIR, 'beta9/nargo');
const NARGO_DEFAULT_BIN     = path.join(NARGO_VERSIONS_DIR, 'beta22/nargo');

// Fail fast and loud at startup if the cached binaries aren't where expected —
// far better than discovering this mid-request after a 7 minute fallback to noirup.
for (const [label, p] of [['beta9', NARGO_WITNESS_BIN], ['beta22', NARGO_DEFAULT_BIN]]) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: cached nargo binary missing for ${label} at ${p}`);
    console.error('Run the one-time caching steps documented above this constant before starting the server.');
    process.exit(1);
  }
}

const TREE = {
  leaf0:  '0x1093aa21e541e164067d7c3f7b6ef75e87d6ef7f5d6fe2909d354cbd8f0ac39f',
  leaf1:  '0x0703245b8184cd1194afde95c21541fd762728dcfdf2db2268a3d58ae59aaeab',
  leaf2:  '0x161cb2a7734b24a636498b07f74876e6b0490be701b0b2a5f63a2327d3410c5f',
  leaf3:  '0x0afa2b0ed8302582dbe1fffdeded477b66252a1b9531acab08c11854815f704c',
  node01: '0x11969ea7cd9b76d8a1cec2c3702a73bf9e73f1d7ec447744f306193bf29a092b',
  node23: '0x27888d464fe3d84ea0a593fd9a4b1a34bc21e9bec80812e8c49a9fe83c13dc9e',
  root:   '0x2356709cffdbacffa82a3302fcaf66cc44203e95e731be01abc59e24a8ae6488',
};

const PATHS = {
  '840': { sibling0: TREE.leaf1,  direction0: false, sibling1: TREE.node23, direction1: false },
  '826': { sibling0: TREE.leaf0,  direction0: true,  sibling1: TREE.node23, direction1: false },
  '124': { sibling0: TREE.leaf3,  direction0: false, sibling1: TREE.node01, direction1: true  },
  '276': { sibling0: TREE.leaf2,  direction0: true,  sibling1: TREE.node01, direction1: true  },
};

// ── Toolchain mutex ───────────────────────────────────────────────────────────
// nargo's active version is a global machine-level setting (noirup switches a
// symlink). Concurrent requests racing on the switch, or racing on the shared
// commitment_hasher / verum_circuit working directories, would corrupt each
// other's output. Serialize the entire prove pipeline end-to-end.
let proveQueue = Promise.resolve();
function withProveLock(fn) {
  const run = proveQueue.then(fn, fn);
  proveQueue = run.catch(() => {});
  return run;
}

function sh(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${NARGO_BIN_DIR}:${process.env.HOME}/.bb/bin:${process.env.PATH}`,
    },
  }).toString();
}

function switchNargo(binPath) {
  fs.copyFileSync(binPath, NARGO_BIN_PATH);
  fs.chmodSync(NARGO_BIN_PATH, 0o755);
}

// Computes the Pedersen commitment for arbitrary holder inputs by running the
// standalone commitment_hasher Noir package, which mirrors verum_circuit's
// commitment binding hash exactly: pedersen_hash([accredited, country, capital, nonce]).
// This replaces a previously hardcoded, stale commitment constant that only
// ever matched one fixed input combination — see handover note discussion.
function computeCommitment({ accredited, countryCode, capital, nonce }) {
  const toml = `accredited_flag = "${accredited ? 1 : 0}"
country_code = "${countryCode}"
committed_capital = "${capital}"
secret_nonce = "${nonce}"
`;
  fs.writeFileSync(path.join(HASHER_DIR, 'Prover.toml'), toml);
  const output = sh('nargo execute', HASHER_DIR);
  const match = output.match(/Circuit output:\s*(0x[0-9a-fA-F]+)/);
  if (!match) {
    const err = new Error('Failed to extract commitment from hasher output.');
    err.httpStatus = 500;
    err.publicMessage = 'Internal error computing commitment.';
    throw err;
  }
  return match[1];
}

app.post('/api/prove', async (req, res) => {
  const { accredited, countryCode, capital, nonce } = req.body;
  if (!countryCode || !capital || !nonce)
    return res.status(400).json({ error: 'Missing required fields.' });

  try {
    const result = await withProveLock(() =>
      proveFlow({ accredited, countryCode, capital, nonce })
    );
    return res.json(result);
  } catch (e) {
    if (e.httpStatus) {
      return res.status(e.httpStatus).json({ error: e.publicMessage });
    }
    console.error('[prove] unexpected error:', e);
    return res.status(500).json({ error: 'Proof generation failed unexpectedly.' });
  }
});

async function proveFlow({ accredited, countryCode, capital, nonce }) {
  // Step 0 — compute the real commitment for these exact inputs.
  // Runs on whichever nargo version is currently active; commitment_hasher
  // has no on-chain dependency so it's toolchain-agnostic — beta.22 is fine.
  const commitment = computeCommitment({ accredited, countryCode, capital, nonce });

  const p = PATHS[countryCode];
  const proverToml = p
    ? `accredited_flag = "${accredited ? 1 : 0}"
country_code = "${countryCode}"
committed_capital = "${capital}"
secret_nonce = "${nonce}"
sibling0 = "${p.sibling0}"
direction0 = ${p.direction0}
sibling1 = "${p.sibling1}"
direction1 = ${p.direction1}
commitment = "${commitment}"
merkle_root = "${TREE.root}"
min_capital_threshold = "50000"
`
    : `accredited_flag = "0"
country_code = "${countryCode}"
committed_capital = "${capital}"
secret_nonce = "${nonce}"
sibling0 = "${TREE.leaf0}"
direction0 = false
sibling1 = "${TREE.node23}"
direction1 = false
commitment = "${commitment}"
merkle_root = "${TREE.root}"
min_capital_threshold = "50000"
`;

  fs.writeFileSync(path.join(CIRCUIT_DIR, 'Prover.toml'), proverToml);

  // Step 1 — fast constraint check on the default toolchain (beta.22).
  // Gives clean, specific rejection reasons without paying the witness-gen cost twice.
  try {
    sh('nargo execute', CIRCUIT_DIR);
  } catch (e) {
    const s = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
    let reason = 'One or more eligibility checks failed.';
    if (s.includes('commitment'))
      reason = 'Commitment check failed — inputs do not match your registered commitment.';
    else if (s.includes('accredited'))
      reason = 'Accreditation check failed — you are not accredited.';
    else if (s.includes('computed_root') || s.includes('merkle'))
      reason = 'Jurisdiction check failed — your country is not in the permitted set.';
    else if (s.includes('committed_capital') || s.includes('capital'))
      reason = 'Capital check failed — committed capital is below the $50,000 minimum.';
    const err = new Error(reason);
    err.httpStatus = 422;
    err.publicMessage = reason;
    throw err;
  }

  // Step 2 — constraints passed. Generate a real, input-specific proof using
  // the pinned toolchain that matches the deployed on-chain verifier.
  //   1) switch nargo to beta.9 to produce a compatible witness
  //   2) run bb v0.87.0 prove with the exact on-chain flags
  //   3) switch nargo back to beta.22 (always, even on failure)
  try {
    switchNargo(NARGO_WITNESS_BIN);
    sh('nargo execute', CIRCUIT_DIR); // regenerates witness in beta.9 format

    sh(
      `${BB_087_PATH} prove ` +
      `--scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields ` +
      `-b target/verum_circuit.json -w target/verum_circuit.gz -o target`,
      CIRCUIT_DIR
    );
  } finally {
    switchNargo(NARGO_DEFAULT_BIN);
  }

  const proofBytes   = fs.readFileSync(path.join(CIRCUIT_DIR, 'target/proof'));
  const publicInputs = fs.readFileSync(path.join(CIRCUIT_DIR, 'target/public_inputs'));

  return {
    success: true,
    proofHex: proofBytes.toString('hex'),
    publicInputsHex: publicInputs.toString('hex'),
    proofSize: proofBytes.length,
    publicInputsSize: publicInputs.length,
    commitment,
  };
}

// POST /api/authorize
app.post('/api/authorize', async (req, res) => {
  const { proofHex, publicInputsHex, holderAddress } = req.body;
  if (!proofHex || !publicInputsHex || !holderAddress)
    return res.status(400).json({ error: 'Missing fields.' });
  try {
    const server  = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
    const keypair = Keypair.fromSecret(ALICE_SECRET);
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(GATE_CONTRACT);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call(
        'verify_and_authorize',
        new Address(holderAddress).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(proofHex, 'hex')),
        xdr.ScVal.scvBytes(Buffer.from(publicInputsHex, 'hex')),
      ))
      .setTimeout(30).build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const result = await server.sendTransaction(prepared);
    if (result.status === 'ERROR')
      return res.status(500).json({ error: 'Transaction failed.', detail: result });
    let txResult;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      txResult = await server.getTransaction(result.hash);
      if (txResult.status !== 'NOT_FOUND') break;
    }
    return res.json({ success: true, txHash: result.hash, status: txResult?.status });
  } catch (err) {
    console.error('[authorize] caught error:', err);
    return res.status(500).json({
      error: err.message || err.toString() || 'Unknown error during authorization.',
      raw: String(err),
    });
  }
});

// POST /api/create-trustline
app.post('/api/create-trustline', async (req, res) => {
  const { holderSecret } = req.body;
  if (!holderSecret) return res.status(400).json({ error: 'Missing holder secret.' });
  try {
    const server  = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
    const keypair = Keypair.fromSecret(holderSecret);
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(SAC_CONTRACT);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call('trust', new Address(keypair.publicKey()).toScVal()))
      .setTimeout(30).build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const result = await server.sendTransaction(prepared);
    if (result.status === 'ERROR') {
      console.error('[create-trustline] sendTransaction ERROR:', JSON.stringify(result, null, 2));
      return res.status(500).json({
        error: 'Trustline transaction rejected by network.',
        detail: result.errorResult?.toString?.() || result,
      });
    }
    let txResult;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000));
      txResult = await server.getTransaction(result.hash);
      if (txResult.status !== 'NOT_FOUND') break;
    }
    if (txResult?.status !== 'SUCCESS') {
      console.error('[create-trustline] final status not SUCCESS:', JSON.stringify(txResult, null, 2));
      return res.status(500).json({
        error: `Trustline transaction did not succeed (status: ${txResult?.status || 'unknown'}).`,
        detail: txResult,
      });
    }
    return res.json({ success: true, txHash: result.hash, address: keypair.publicKey() });
  } catch (err) {
    console.error('[create-trustline] caught error:', err);
    return res.status(500).json({
      error: err.message || err.toString() || 'Unknown error during trustline creation.',
      raw: String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Verum demo server -> http://localhost:${PORT}`);
  console.log('Gate:    ' + GATE_CONTRACT);
  console.log('Network: ' + NETWORK_PASSPHRASE);
});
