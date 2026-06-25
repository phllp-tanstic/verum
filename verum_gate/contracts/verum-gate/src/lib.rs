#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, Env, Symbol, Val, vec,
    token::StellarAssetClient,
};

#[contracttype]
pub enum DataKey {
    VerifierContract,
    AssetAddress,
    Issuer,
}

#[contract]
pub struct VerumGate;

#[contractimpl]
impl VerumGate {
    pub fn initialize(
        env: Env,
        verifier_contract: Address,
        asset_address: Address,
        issuer: Address,
    ) {
        env.storage().instance().set(&DataKey::VerifierContract, &verifier_contract);
        env.storage().instance().set(&DataKey::AssetAddress, &asset_address);
        env.storage().instance().set(&DataKey::Issuer, &issuer);
    }

    pub fn verify_and_authorize(
        env: Env,
        holder: Address,
        proof_bytes: Bytes,
        public_inputs: Bytes,
    ) {
        let issuer: Address = env.storage().instance().get(&DataKey::Issuer).unwrap();
        issuer.require_auth();

        let verifier: Address = env.storage().instance().get(&DataKey::VerifierContract).unwrap();

        let args: soroban_sdk::Vec<Val> = vec![&env, public_inputs.into(), proof_bytes.into()];
        env.invoke_contract::<()>(&verifier, &Symbol::new(&env, "verify_proof"), args);

        let asset: Address = env.storage().instance().get(&DataKey::AssetAddress).unwrap();
        let sac = StellarAssetClient::new(&env, &asset);
        sac.set_authorized(&holder, &true);

        env.events().publish((symbol_short!("verum"), symbol_short!("auth")), holder);
    }
}
