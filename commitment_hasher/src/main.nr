// Standalone commitment hasher — mirrors the exact Pedersen hash
// used in verum_circuit/src/main.nr's commitment binding check.
// Must stay byte-for-byte identical to that hash call or proofs
// generated against a server-computed commitment will fail
// constraint checking in the real circuit.
fn main(
    accredited_flag: Field,
    country_code: Field,
    committed_capital: u64,
    secret_nonce: Field,
) -> pub Field {
    std::hash::pedersen_hash(
        [accredited_flag, country_code, committed_capital as Field, secret_nonce]
    )
}
