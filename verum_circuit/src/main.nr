fn main(
    accredited_flag: Field,
    country_code: Field,
    committed_capital: u64,
    secret_nonce: Field,
    sibling0: Field,
    direction0: bool,
    sibling1: Field,
    direction1: bool,
    commitment: pub Field,
    merkle_root: pub Field,
    min_capital_threshold: pub u64
) {
    let computed_commitment = std::hash::pedersen_hash(
        [accredited_flag, country_code, committed_capital as Field, secret_nonce]
    );
    assert(computed_commitment == commitment);
    assert(accredited_flag == 1);

    let leaf = std::hash::pedersen_hash([country_code]);
    let node0 = if direction0 {
        std::hash::pedersen_hash([sibling0, leaf])
    } else {
        std::hash::pedersen_hash([leaf, sibling0])
    };
    let computed_root = if direction1 {
        std::hash::pedersen_hash([sibling1, node0])
    } else {
        std::hash::pedersen_hash([node0, sibling1])
    };
    assert(computed_root == merkle_root);
    assert(committed_capital >= min_capital_threshold);
}
