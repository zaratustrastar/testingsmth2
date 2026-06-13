import { BrowserProvider, Contract, formatUnits, getAddress, isAddress, parseEther, parseUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm'

const FACTORY_ADDRESS = '0xc70EC113A79bC48f7C3D86Ff672f7AB5560024aB'
const MARKETPLACE_ADDRESS = ''
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CREATION_FEE_ETH = '0.001'
const SALE_FEE_BPS = 10n
const DEMO_MODE = false
const BASE_RPC = 'https://mainnet.base.org'
const WAD = 10n ** 18n
const STORAGE_KEY = 'pmfi-option-backed-plans-v2'

const app = document.getElementById('app')
const $ = (id) => document.getElementById(id)
let provider
let signer
let account = ''
let abis = {}
let activeTab = 'borrow'
let selectedLendId = ''
let notice = ''
let markets = []

function fmt(value, decimals = 18, max = 4) {
  try {
    const raw = typeof value === 'bigint' ? formatUnits(value, decimals) : String(value)
    const n = Number(raw)
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: max }) : raw
  } catch { return '0' }
}
function money(n) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) }
function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—' }
function explorer(v, type = 'address') { return `https://basescan.org/${type}/${v}` }
function parseSafe(v, d) { try { return v && Number(v) > 0 ? parseUnits(String(v), d) : 0n } catch { return 0n } }
function nowSec() { return Math.floor(Date.now() / 1000) }
function apr(investment, payoff, start, end) { return investment > 0 && payoff > investment && end > start ? ((payoff - investment) / investment) * (31536000 / (end - start)) * 100 : 0 }
function calcStrikeWad(repayUsdc, amount, decimals) {
  const repay = parseSafe(repayUsdc, 6)
  const collateral = parseSafe(amount, decimals)
  return collateral ? (repay * (10n ** BigInt(decimals)) * WAD) / (collateral * 10n ** 6n) : 0n
}
function readPlans() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
function writePlan(vault, plan) { const plans = readPlans(); plans[vault.toLowerCase()] = plan; localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)) }
function status(message, bad = false) {
  const el = $('notice')
  if (!el) return
  el.hidden = false
  el.className = `notice ${bad ? 'danger' : ''}`
  el.innerHTML = message
}
function tokenIcon(kind = 'custom') { return `<span class="token-icon ${kind}">${kind === 'arb' ? '◢' : kind === 'op' ? 'OP' : kind === 'uni' ? '◇' : kind === 'aave' ? 'A' : '•'}</span>` }
function infoTip() { return '<span class="info">i</span>' }

async function loadAbis() {
  const names = ['SplitVaultFactory', 'SplitVault', 'LegToken', 'FixedPricePSale']
  abis = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await fetch(`/src/abi/${name}.abi.json`).then((r) => r.json())])))
}
function fallbackProvider() {
  return new BrowserProvider(window.ethereum || { request: async ({ method, params }) => {
    const res = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    return json.result
  } })
}
async function contract(address, abi, writable = false) { return new Contract(address, abi, writable && signer ? signer : (provider || fallbackProvider())) }
async function connect() {
  if (!window.ethereum) return status('No injected wallet found. Connect a wallet to fetch balances and create positions.', true)
  provider = new BrowserProvider(window.ethereum)
  await provider.send('eth_requestAccounts', [])
  signer = await provider.getSigner()
  account = await signer.getAddress()
  await render()
}
async function send(label, action) {
  try {
    status(`<strong>${label}</strong> Waiting for wallet confirmation…`)
    const tx = await action()
    status(`<strong>${label}</strong> <a target="_blank" href="${explorer(tx.hash, 'tx')}">${short(tx.hash)}</a>`)
    await tx.wait()
    status(`<strong>${label}</strong> confirmed.`)
    await loadOnchainMarkets()
    await render()
    return tx
  } catch (error) {
    status(`<strong>${label}</strong> ${error.shortMessage || error.message || error}`, true)
    throw error
  }
}
async function loadOnchainMarkets() {
  try {
    const factory = await contract(FACTORY_ADDRESS, abis.SplitVaultFactory)
    const len = Number(await factory.allVaultsLength())
    const vaults = await Promise.all(Array.from({ length: len }, (_, i) => factory.allVaults(i)))
    const plans = readPlans()
    markets = await Promise.all(vaults.map(async (vault) => {
      const v = await contract(vault, abis.SplitVault)
      const [collateral, pToken, nToken, maturity, exerciseDeadline, strikeWad, settled] = await Promise.all([v.collateral(), v.P(), v.N(), v.maturity(), v.exerciseDeadline(), v.strikeWad(), v.settled()])
      const erc20 = await contract(collateral, abis.LegToken)
      const p = await contract(pToken, abis.LegToken)
      const [symbol, name, decimals, pSupply, pBalance] = await Promise.all([
        erc20.symbol().catch(() => 'TOKEN'), erc20.name().catch(() => 'Custom token'), erc20.decimals().catch(() => 18n), p.totalSupply().catch(() => 0n), account ? p.balanceOf(account).catch(() => 0n) : 0n,
      ])
      const plan = plans[vault.toLowerCase()] || {}
      const raise = Number(plan.targetRaiseUsdc || 0)
      const repay = Number(plan.repayUsdc || 0)
      return { id: vault, vault, token: symbol, name, logo: 'custom', decimals: Number(decimals), raise, repay, term: 'Fixed', apr: apr(raise, repay, nowSec(), Number(exerciseDeadline)), available: Number(fmt(pBalance, Number(decimals), 6)), collateral: Number(plan.collateralAmount || fmt(pSupply, Number(decimals), 6)), deadline: new Date(Number(maturity) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), status: settled ? 'Redeemable' : 'Open', pToken, nToken, strikeWad }
    }))
    notice = ''
  } catch (error) {
    markets = []
    notice = 'Live market data is unavailable right now. You can still paste a collateral token and create a borrow position.'
  }
}
function visibleMarkets() { return markets }
function selectedMarket() { return visibleMarkets().find((m) => m.id === selectedLendId) || visibleMarkets()[0] }
function tabCopy() {
  if (activeTab === 'borrow') return 'Raise USDC by locking token collateral. No oracle. No liquidation. Fixed repayment.'
  if (activeTab === 'lend') return 'Lend USDC into fixed repayment positions. If repaid, earn fixed yield. If unpaid, claim collateral fallback.'
  return 'Track your borrow positions and lender positions in one place.'
}

async function render() {
  try {
    app.innerHTML = `<div class="shell">
      <header class="topbar"><p>${tabCopy()}</p><button id="connect" class="connect">${account ? short(account) : 'Connect wallet'}</button></header>
      <nav class="tabs" aria-label="Main tabs"><button data-tab="borrow" class="${activeTab === 'borrow' ? 'active' : ''}">Borrow</button><button data-tab="lend" class="${activeTab === 'lend' ? 'active' : ''}">Lend</button><button data-tab="portfolio" class="${activeTab === 'portfolio' ? 'active' : ''}">Portfolio</button></nav>
      <div id="notice" class="notice" ${notice ? '' : 'hidden'}>${notice}</div>
      <main id="view"></main>
    </div>`
    $('connect').onclick = connect
    document.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => { activeTab = button.dataset.tab; render() })
    if (activeTab === 'borrow') renderBorrow()
    if (activeTab === 'lend') renderLend()
    if (activeTab === 'portfolio') renderPortfolio()
  } catch (error) {
    app.innerHTML = `<div class="shell"><div class="notice danger"><strong>UI recovered from an error.</strong> ${error.message || error}</div><button class="connect" onclick="location.reload()">Reload</button></div>`
  }
}

function renderBorrow() {
  $('view').innerHTML = `<section class="borrow-layout">
    <div class="card form-card">
      <div class="card-head"><h2>Create borrow position</h2><span>Custom ERC20</span></div>
      <label>Collateral token</label>
      <div class="search-input"><span>⌕</span><input id="collateral" placeholder="Paste token contract address"><button id="fetchToken" class="fetch-btn">Fetch</button></div>
      <div id="tokenBox" class="token-summary" hidden></div>
      <label>Amount to lock</label><div class="amount-row"><input id="lockAmount" placeholder="0.00"><label class="switch"><input id="useMax" type="checkbox"><span></span>Use max</label></div><p class="hint" id="balanceHint">Connect wallet and fetch a token to see your balance.</p>
      <div class="two-cols"><label>USDC to raise ${infoTip()}<div class="unit-input"><input id="raiseUsdc" placeholder="0"><span>USDC</span></div></label><label>Repay to reclaim ${infoTip()}<div class="unit-input"><input id="repayUsdc" placeholder="0"><span>USDC</span></div></label></div>
      <label>Term ${infoTip()} <strong id="termLabel" class="term-label">6 months</strong></label>
      <input id="termMonths" type="range" min="1" max="12" value="6">
      <button id="createBorrow" class="primary-action">Create borrow position</button><p class="fee-note">Factory creation fee ${CREATION_FEE_ETH} ETH ${infoTip()}</p>
    </div>
    <aside><div class="card preview-card"><h2>Position preview</h2><div id="borrowPreview"></div><div class="important">${infoTip()}<div><strong>Important</strong><p>If not repaid by the deadline, P holders can redeem the collateral fallback.</p></div></div></div><div class="card split-card"><h2>PMFI P/N construction</h2>${splitModule()}</div></aside>
  </section>`
  let token = { symbol: 'TOKEN', name: '', decimals: 18, balance: 0n, loaded: false }
  let tokenAddress = ''
  const monthsToDate = (m) => { const d = new Date(); d.setMonth(d.getMonth() + Number(m)); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
  const update = () => {
    const lock = Number($('lockAmount').value || 0), raise = Number($('raiseUsdc').value || 0), repay = Number($('repayUsdc').value || 0), months = Number($('termMonths').value || 6)
    $('termLabel').textContent = `${months} ${months === 1 ? 'month' : 'months'}`
    const deadline = monthsToDate(months)
    $('borrowPreview').innerHTML = previewRows([
      ['You lock', `${money(lock)} ${token.symbol}`], ['You receive', `${money(raise)} USDC when funded`], ['You keep', 'N reclaim option'], ['Repay to reclaim', `${money(repay)} USDC`], ['Deadline', deadline],
    ])
  }
  $('fetchToken').onclick = async () => {
    const input = $('collateral').value.trim()
    if (!isAddress(input)) return status('Enter a valid ERC20 contract address.', true)
    if (!account) return status('Connect wallet first so the app can fetch your token balance.', true)
    const erc20 = await contract(getAddress(input), abis.LegToken)
    const [symbol, name, decimals, balance] = await Promise.all([erc20.symbol().catch(() => 'TOKEN'), erc20.name().catch(() => 'Custom token'), erc20.decimals().catch(() => 18n), erc20.balanceOf(account).catch(() => 0n)])
    token = { symbol, name, decimals: Number(decimals), balance, loaded: true }
    tokenAddress = getAddress(input)
    $('tokenBox').hidden = false
    $('tokenBox').innerHTML = `<div><strong>${symbol}</strong><small>${name}</small></div><div class="balance"><small>Wallet balance</small><strong>${fmt(balance, Number(decimals), 8)} ${symbol}</strong></div>`
    $('balanceHint').textContent = `Balance ${fmt(balance, Number(decimals), 8)} ${symbol}`
    if ($('useMax').checked) $('lockAmount').value = fmt(balance, Number(decimals), 8)
    update()
  }
  $('useMax').onchange = () => { if ($('useMax').checked) $('lockAmount').value = fmt(token.balance, token.decimals, 8); update() }
  ;['lockAmount', 'raiseUsdc', 'repayUsdc', 'termMonths'].forEach((id) => $(id).oninput = update)
  $('createBorrow').onclick = async () => {
    if (!account) return status('Connect wallet to create a real borrow position.', true)
    if (!tokenAddress) return status('Paste and fetch a real ERC20 collateral address before creating an on-chain vault.', true)
    const months = Number($('termMonths').value || 6)
    const maturity = BigInt(nowSec() + months * 2628000)
    const factory = await contract(FACTORY_ADDRESS, abis.SplitVaultFactory, true)
    const strikeWad = calcStrikeWad($('repayUsdc').value, $('lockAmount').value, token.decimals)
    const tx = await send('Create borrow position', () => factory.createVault(tokenAddress, BASE_USDC, strikeWad, maturity, 7n * 86400n, `opl ${token.symbol}`, `opl${token.symbol}`, { value: parseEther(CREATION_FEE_ETH) }))
    const len = Number(await factory.allVaultsLength())
    const vault = await factory.allVaults(len - 1)
    writePlan(vault, { collateralAmount: $('lockAmount').value, targetRaiseUsdc: $('raiseUsdc').value, repayUsdc: $('repayUsdc').value, txHash: tx.hash })
  }
  update()
}

function renderLend() {
  const rows = visibleMarkets()
  const selected = selectedMarket()
  $('view').innerHTML = `<section class="lend-layout"><div class="card table-card"><h2>Open lend positions</h2><div class="table-tools"><div class="search-input"><span>⌕</span><input placeholder="Search token"></div><button class="sort">Highest APR ⌄</button></div><div class="market-table"><div class="thead"><span>Collateral</span><span>Raise</span><span>Repay</span><span>Term</span><span>APR ${infoTip()}</span><span>Available</span><span>Action</span></div>${rows.length ? rows.map(lendRow).join('') : '<div class="empty-state">No live lend listings found yet.</div>'}</div></div><aside><div class="card action-card" id="lendPreview"></div><div class="card split-card">${splitModule()}</div></aside></section>`
  document.querySelectorAll('[data-select-market]').forEach((b) => b.onclick = () => { selectedLendId = b.dataset.selectMarket; renderLend() })
  $('lendPreview').innerHTML = selected ? lendPreview(selected) : '<h2>Lend into position</h2><p class="hint">Live P listings will appear here once available.</p>'
  if ($('fundPosition')) $('fundPosition').onclick = () => status('Marketplace funding will be enabled when a marketplace contract address is configured.', true)
}
function lendRow(m) {
  const active = m.id === selectedLendId ? 'selected' : ''
  return `<div class="trow ${active}"><span class="asset-cell">${tokenIcon(m.logo)}<span><strong>${m.token}</strong><small>${m.name}</small></span></span><span>${money(m.raise)} USDC</span><span>${money(m.repay)} USDC</span><span>${m.term}</span><span class="green">${m.apr.toFixed(1)}%</span><span>${money(m.available)} USDC</span><button data-select-market="${m.id}" class="link-btn">View</button></div>`
}
function lendPreview(m) {
  return `<h2>Lend into position</h2><div class="asset-large">${tokenIcon(m.logo)}<div><strong>${m.token}</strong><small>${m.name}</small></div></div>${previewRows([['Available to fund', `${money(m.available)} USDC`]])}<label>USDC to lend</label><div class="unit-input"><input value="${money(m.available)}"><span>◉ USDC</span></div>${previewRows([['You pay', `${money(m.available)} USDC`], ['You receive if repaid', `${money(m.available * (m.repay / m.raise))} USDC`], ['Term', m.term.replace('m', ' months')], [`Lender APR ${infoTip()}`, `<span class="green">${m.apr.toFixed(1)}%</span>`], ['Deadline', m.deadline]])}<div class="important">${infoTip()}<div><strong>Important</strong><p>If the borrower does not repay by the deadline, lenders can claim the collateral fallback.</p></div></div><button id="fundPosition" class="primary-action">Fund position</button>`
}

function renderPortfolio() {
  $('view').innerHTML = `<section class="portfolio"><div class="card table-card"><h2>Your borrow positions</h2><div class="empty-state">Connect wallet and create a market to track borrower positions here.</div></div><div class="card table-card"><h2>Your lend positions</h2><div class="empty-state">Live funded P positions will appear here.</div></div></section>`
}
function asset(p) { return `<span class="asset-cell">${tokenIcon(p.logo)}<span><strong>${p.token}</strong><small>${p.name}</small></span></span>` }
function badge(statusText) { return `<span class="badge ${statusText.toLowerCase()}">${statusText}</span>` }
function portfolioTable(head, rows) { return `<div class="portfolio-table"><div class="portfolio-head">${head.map((h) => `<span>${h}</span>`).join('')}</div>${rows.map((r) => `<div class="portfolio-row">${r.map((c) => `<span>${c}</span>`).join('')}</div>`).join('')}</div>` }

function splitModule() { return `<div class="split-module"><div class="split-diagram"><div class="split-top">Collateral</div><div class="split-line"></div><div class="split-legs"><div><strong>P</strong><span>Lender claim</span></div><div><strong>N</strong><span>Reclaim option</span></div></div><small>P + N are minted from the same locked collateral amount.</small></div><div class="split-copy"><p><strong>P token</strong> is the lender claim. It is sold for USDC to activate funding.</p><p><strong>N token</strong> stays with the borrower as the repay-to-reclaim option.</p><p>No oracle or liquidation path is used. At expiry, repayment sends USDC to P holders; non-repayment leaves collateral redeemable by P holders.</p></div></div>` }

function previewRows(rows) { return `<div class="preview-rows">${rows.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>` }
async function boot() {
  app.innerHTML = '<div class="shell"><div class="notice">Loading PMFI interface…</div></div>'
  try { await loadAbis() } catch (error) { notice = 'ABI files could not be loaded. Contract actions are temporarily unavailable.' }
  try {
    if (window.ethereum) {
      provider = new BrowserProvider(window.ethereum)
      const accounts = await provider.send('eth_accounts', []).catch(() => [])
      if (accounts[0]) { signer = await provider.getSigner(); account = await signer.getAddress() }
    }
    await loadOnchainMarkets()
  } catch (error) { notice = 'Wallet or RPC initialization failed. The interface is still available for token entry.' }
  await render()
}
boot().catch((error) => { app.innerHTML = `<div class="shell"><div class="notice danger"><strong>Could not initialize.</strong> ${error.message || error}</div></div>` })
