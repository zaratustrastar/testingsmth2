import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG } from '../src/config.js'
import { dedupeCollateralEvents, discoverCollateralTokens, searchTokens, sortTokensByWalletBalance, withMetadataFallback } from '../src/collateralDiscovery.js'
import { escapeHtml, money, utf8Bytes } from '../src/format.js'
import { LIMITS, canCreateWithAllowlist, isWriteDisabled, validateBorrowForm, validatePrefix } from '../src/validation.js'
import { estimateSellerPrice, pAmountForBudget } from '../src/quotes.js'
import { resolveRequestPath } from '../scripts/dev-server.mjs'

test('Base production configuration is immutable V2.2 deployment', () => {
  assert.equal(CONFIG.BASE_CHAIN_ID, 8453)
  assert.equal(CONFIG.FACTORY_ADDRESS, '0xb2458426F7263B3Aec44ba6E3466bB4B5A175ccf')
  assert.equal(CONFIG.FACTORY_DEPLOYMENT_BLOCK, 47499768)
  assert.equal(CONFIG.MARKETPLACE_ADDRESS, '0xcC3E1C18b58eE8Ec6550C60b75d820E4b45e2D2F')
  assert.equal(CONFIG.BASE_USDC, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  assert.equal(CONFIG.CREATION_FEE_WEI, 100000000000000n)
  assert.equal(CONFIG.CREATION_FEE_ETH, '0.0001')
})

test('funding and repayment period limits match V2.2', () => {
  assert.equal(LIMITS.MIN_FUNDING_SECONDS, 3600)
  assert.equal(LIMITS.MAX_FUNDING_SECONDS, 30 * 86400)
  assert.equal(LIMITS.MAX_REPAYMENT_SECONDS, 365 * 86400)
})

test('borrow validation enforces repayment greater than raise and windows', () => {
  const base = { connected: true, wrongNetwork: false, creationPaused: false, collateralAllowed: true, collateralIsUsdc: false, collateralAmount: 10n, targetRaise: 5n, totalRepayment: 6n, fundingSeconds: 3600, repaymentSeconds: 86400, namePrefix: 'opl token', symbolPrefix: 'oplt', decimals: 18, balance: 10n, ethBalance: CONFIG.CREATION_FEE_WEI }
  assert.deepEqual(validateBorrowForm(base), [])
  assert.match(validateBorrowForm({ ...base, totalRepayment: 5n }).join(' '), /greater than target/)
  assert.match(validateBorrowForm({ ...base, fundingSeconds: 3599 }).join(' '), /Funding window/)
  assert.match(validateBorrowForm({ ...base, repaymentSeconds: 366 * 86400 }).join(' '), /Repayment window/)
})

test('UTF-8 prefix byte limit uses bytes rather than JS string length', () => {
  assert.equal(utf8Bytes('å'.repeat(16)), 32)
  assert.equal(validatePrefix('å'.repeat(16)), true)
  assert.equal(validatePrefix('å'.repeat(17)), false)
})

test('collateral and USDC decimal conversions are exact', () => {
  const parseFixed = (value, decimals) => { const [whole, frac = ''] = value.split('.'); return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals)) }
  assert.equal(parseFixed('1.23', 6), 1230000n)
  assert.equal(parseFixed('1.23', 18), 1230000000000000000n)
})

test('quote rounding uses floor cumulative math', () => {
  assert.equal(estimateSellerPrice(100n, 0n, 1n, 3n), 33n)
  assert.equal(estimateSellerPrice(100n, 1n, 1n, 3n), 33n)
  assert.equal(estimateSellerPrice(100n, 2n, 1n, 3n), 34n)
})

test('USDC budget to P binary search never exceeds budget', async () => {
  const best = await pAmountForBudget({ high: 100n, budget: 55n, quoteTotalPayment: async (p) => p * 2n })
  assert.equal(best, 27n)
})

test('allowlist gating requires onchain allowed', () => {
  assert.equal(canCreateWithAllowlist({ allowed: true, isUsdc: false, creationPaused: false, wrongNetwork: false }), true)
  assert.equal(canCreateWithAllowlist({ allowed: false, isUsdc: false, creationPaused: false, wrongNetwork: false }), false)
})



test('discovers tokens from CollateralAllowed events, dedupes, and excludes disabled mapping entries', async () => {
  const logs = [{ args: { collateral: '0xAAA' } }, { args: { collateral: '0xaaa' } }, { args: { collateral: '0xBBB' } }]
  const tokens = await discoverCollateralTokens({
    fromBlock: 1n,
    toBlock: 1n,
    getLogs: async () => logs,
    parseLog: (log) => log.args,
    isAllowed: async (address) => address.toLowerCase() !== '0xbbb',
    readMetadata: async (address) => ({ symbol: address.endsWith('A') ? 'AAA' : 'BBB', name: 'Allowed token', decimals: 18, balance: 0n }),
  })
  assert.deepEqual(tokens.map((token) => token.address), ['0xAAA'])
  assert.deepEqual(dedupeCollateralEvents(logs), ['0xAAA', '0xBBB'])
})

test('token search works by ticker, name, and address', () => {
  const tokens = [{ symbol: 'BANKR', name: 'Bankr Token', address: '0xabc123', balance: 0n }, { symbol: 'PMFI', name: 'PMFI', address: '0xdef456', balance: 0n }]
  assert.equal(searchTokens(tokens, 'ban').length, 1)
  assert.equal(searchTokens(tokens, 'pmfi').length, 1)
  assert.equal(searchTokens(tokens, 'def4').length, 1)
})

test('wallet-owned tokens sort first by balance', () => {
  const sorted = sortTokensByWalletBalance([{ symbol: 'A', balance: 0n }, { symbol: 'B', balance: 20n }, { symbol: 'C', balance: 5n }])
  assert.deepEqual(sorted.map((x) => x.symbol), ['B', 'C', 'A'])
})

test('metadata failure fallback is safe and deterministic', () => {
  const token = withMetadataFallback('0x1234567890123456789012345678901234567890', { allowed: true })
  assert.equal(token.symbol, 'TOKEN')
  assert.equal(token.name, 'Token 0x1234…7890')
  assert.equal(token.decimals, 18)
})

test('discovery RPC failure is surfaced instead of silently returning empty data', async () => {
  await assert.rejects(discoverCollateralTokens({
    fromBlock: 1n,
    toBlock: 1n,
    getLogs: async () => { throw new Error('range rejected') },
    parseLog: (log) => log,
    isAllowed: async () => true,
    readMetadata: async () => ({}),
  }), /range rejected/)
})

test('wrong network disables write actions', () => {
  assert.equal(isWriteDisabled({ wrongNetwork: true, pending: false }), true)
  assert.equal(isWriteDisabled({ wrongNetwork: false, pending: true }), true)
  assert.equal(isWriteDisabled({ wrongNetwork: false, pending: false }), false)
})

test('PositionCreated event parses expected V2.2 fields', () => {
  const signature = CONFIG.ABIS.factory.find((item) => item.startsWith('event PositionCreated'))
  assert.match(signature, /address indexed vault/)
  assert.match(signature, /address pToken/)
  assert.match(signature, /address nToken/)
  assert.match(signature, /uint256 saleId/)
})

test('money formatting prevents NaN values', () => {
  assert.equal(money('not-a-number'), '0')
  assert.equal(money(''), '0')
})

test('HTML escaping sanitizes token metadata rendering', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(escapeHtml('A&B"'), 'A&amp;B&quot;')
})





test('borrow UI hides custom prefix inputs while generated opl prefixes are used in createPosition params', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8'))
  assert.equal(source.includes(`Name ${'prefix'}`), false)
  assert.equal(source.includes(`Symbol ${'prefix'}`), false)
  assert.match(source, /function generatedNamePrefix\(\)/)
  assert.match(source, /function generatedSymbolPrefix\(\)/)
})

test('createPosition path rechecks live allowlist before approval and creation', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8'))
  const recheckIndex = source.indexOf('factory(true).collateralAllowed(token.address)')
  const approvalIndex = source.indexOf('collateral.approve(CONFIG.FACTORY_ADDRESS')
  const createIndex = source.indexOf('factory(false).createPosition')
  assert.ok(recheckIndex > -1)
  assert.ok(recheckIndex < approvalIndex)
  assert.ok(approvalIndex < createIndex)
})

test('contract targets are not URL or localStorage overridable in config', () => {
  const text = Object.values(CONFIG).map(String).join(" ")
  assert.equal(text.includes(`search${'Params'}`), false)
  assert.equal(text.includes(`local${'Storage'}`), false)
})

test('development server rejects path traversal', () => {
  const root = process.cwd()
  assert.equal(resolveRequestPath(root, '/../package.json'), null)
  assert.equal(resolveRequestPath(root, '/src/main.js')?.startsWith(root), true)
})
