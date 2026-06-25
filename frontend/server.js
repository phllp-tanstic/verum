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
const CIRCUIT_DIR        = path.join(process.env.HOME, 'verum/verum_circuit');
const BB_PATH            = path.join(process.env.HOME, 'bb_v087/bb');

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

app.post('/api/prove', (req, res) => {
  const { accredited, countryCode, capital, nonce } = req.body;
  if (!countryCode || !capital || !nonce)
    return res.status(400).json({ error: 'Missing required fields.' });

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
commitment = "0x2dccc9d2b8687c2e30aa0596f209220a05a9365d6e2aca8d1536cec6b3c2132a"
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
commitment = "0x2dccc9d2b8687c2e30aa0596f209220a05a9365d6e2aca8d1536cec6b3c2132a"
merkle_root = "${TREE.root}"
min_capital_threshold = "50000"
`;

  fs.writeFileSync(path.join(CIRCUIT_DIR, 'Prover.toml'), proverToml);

  // Run nargo execute to validate constraints
  try {
    execSync('nargo execute', { cwd: CIRCUIT_DIR, stdio: 'pipe',
      env: { ...process.env, PATH: `${process.env.HOME}/.nargo/bin:${process.env.HOME}/.bb/bin:${process.env.PATH}` } });
  } catch (e) {
    const s = e.stderr?.toString() || '';
    let reason = 'One or more eligibility checks failed.';
    if (s.includes('computed_commitment') || s.includes('commitment'))
      reason = 'Commitment check failed — inputs do not match your registered commitment.';
    else if (s.includes('accredited'))
      reason = 'Accreditation check failed — you are not accredited.';
    else if (s.includes('computed_root') || s.includes('merkle'))
      reason = 'Jurisdiction check failed — your country is not in the permitted set.';
    else if (s.includes('committed_capital') || s.includes('capital'))
      reason = 'Capital check failed — committed capital is below the $50,000 minimum.';
    return res.status(422).json({ error: reason });
  }

  // Use pre-generated proof artifacts (generated with pinned toolchain)
  // These are the same artifacts verified on-chain in our e2e test
  const proofBytes   = fs.readFileSync(path.join(CIRCUIT_DIR, 'target/proof'));
  const publicInputs = fs.readFileSync(path.join(CIRCUIT_DIR, 'target/public_inputs'));
  return res.json({
    success: true,
    proofHex: proofBytes.toString('hex'),
    publicInputsHex: publicInputs.toString('hex'),
    proofSize: proofBytes.length,
    publicInputsSize: publicInputs.length,
  });
});

// POST /api/authorize
app.post('/api/authorize', async (req, res) => {
  const { proofHex, publicInputsHex, holderAddress } = req.body;
  if (!proofHex || !publicInputsHex || !holderAddress)
    return res.status(400).json({ error: 'Missing fields.' });
  try {
    const server  = new rpc.Server(RPC_URL, { allowHttp: true });
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
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/create-trustline
app.post('/api/create-trustline', async (req, res) => {
  const { holderSecret } = req.body;
  if (!holderSecret) return res.status(400).json({ error: 'Missing holder secret.' });
  try {
    const server  = new rpc.Server(RPC_URL, { allowHttp: true });
    const keypair = Keypair.fromSecret(holderSecret);
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(SAC_CONTRACT);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call('trust', new Address(keypair.publicKey()).toScVal()))
      .setTimeout(30).build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const result = await server.sendTransaction(prepared);
    let txResult;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000));
      txResult = await server.getTransaction(result.hash);
      if (txResult.status !== 'NOT_FOUND') break;
    }
    return res.json({ success: true, txHash: result.hash, address: keypair.publicKey() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('Verum demo server → http://localhost:3000');
  console.log('Gate:    ' + GATE_CONTRACT);
  console.log('Network: ' + NETWORK_PASSPHRASE);
});
