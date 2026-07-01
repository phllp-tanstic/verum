import { Noir } from '@noir-lang/noir_js';
import { compressWitness } from '@noir-lang/acvm_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { readFileSync } from 'fs';

const circuit = JSON.parse(readFileSync('./src/circuit.json', 'utf8'));

const inputs = {
  accredited_flag: '1',
  country_code: '826',
  committed_capital: '75000',
  secret_nonce: '12345',
  sibling0: '0x1093aa21e541e164067d7c3f7b6ef75e87d6ef7f5d6fe2909d354cbd8f0ac39f',
  direction0: true,
  sibling1: '0x27888d464fe3d84ea0a593fd9a4b1a34bc21e9bec80812e8c49a9fe83c13dc9e',
  direction1: false,
  commitment: '0x2dccc9d2b8687c2e30aa0596f209220a05a9365d6e2aca8d1536cec6b3c2132a',
  merkle_root: '0x2356709cffdbacffa82a3302fcaf66cc44203e95e731be01abc59e24a8ae6488',
  min_capital_threshold: '50000',
};

console.log('Initializing Noir...');
const noir = new Noir(circuit);

console.log('Generating witness...');
const { witness } = await noir.execute(inputs);
console.log('Witness type:', typeof witness, witness?.constructor?.name);

console.log('Compressing witness...');
const compressedWitness = compressWitness(witness);
console.log('Compressed witness size:', compressedWitness.length, 'bytes');

console.log('Initializing Barretenberg API...');
const api = await Barretenberg.new({ threads: 4 });

console.log('Creating UltraHonkBackend...');
const backend = new UltraHonkBackend(circuit.bytecode, api);

console.log('Generating proof...');
const proof = await backend.generateProof(compressedWitness);
console.log('Proof generated! Size:', proof.proof.length, 'bytes');

console.log('Verifying proof locally...');
const valid = await backend.verifyProof(proof);
console.log('Proof valid:', valid);

await api.destroy();
process.exit(0);
