import { Contract, JsonRpcProvider } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm'
import { CONFIG } from './config.js'

export function fallbackProvider() { return new JsonRpcProvider(CONFIG.BASE_RPC, CONFIG.BASE_CHAIN_ID) }
export function readContract(address, abi, provider = fallbackProvider()) { return new Contract(address, abi, provider) }
export function writeContract(address, abi, signer) { return new Contract(address, abi, signer) }
export function explorerLink(value, type = 'address') { return `${CONFIG.EXPLORER_URL}/${type}/${value}` }
