import { BrowserProvider, Contract, formatUnits, getAddress, isAddress, parseEther, parseUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm'

const FACTORY_ADDRESS = '0xc70EC113A79bC48f7C3D86Ff672f7AB5560024aB'
const MARKETPLACE_ADDRESS = ''
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CREATION_FEE_ETH = '0.001'
const SALE_FEE_BPS = 10n
const WAD = 10n ** 18n
const BASE_RPC = 'https://mainnet.base.org'
const STORAGE_KEY = 'pmfi-option-backed-plans-v1'

const $ = (id) => document.getElementById(id)
const app = $('app')
let account = ''
let signer, provider
let abis = {}
let markets = []
let selectedMarket = null
let activeTab = 'markets'

function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—' }
function explorer(v, type = 'address') { return `https://basescan.org/${type}/${v}` }
function nowSec() { return Math.floor(Date.now() / 1000) }
function fmt(v = 0n, d = 18, max = 4) {
  const raw = formatUnits(v, d)
  const n = Number(raw)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: max }) : raw
}
function date(v) { return v ? new Date(Number(v) * 1000).toLocaleString() : '—' }
function readPlans() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
function writePlan(vault, plan) { const plans = readPlans(); plans[vault.toLowerCase()] = plan; localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)) }
function parseSafe(v, d) { try { return v && Number(v) > 0 ? parseUnits(v, d) : 0n } catch { return 0n } }
function apr(investment, payoff, start, end) { return investment > 0 && payoff > investment && end > start ? ((payoff - investment) / investment) * (31536000 / (end - start)) * 100 : 0 }
function costApr(proceeds, repay, start, end) { return proceeds > 0 && repay > proceeds && end > start ? ((repay - proceeds) / proceeds) * (31536000 / (end - start)) * 100 : 0 }
function calcStrikeWad(repayUsdc, amount, collateralDecimals) {
  const repay = parseSafe(repayUsdc, 6), amt = parseSafe(amount, collateralDecimals)
  return amt ? (repay * (10n ** BigInt(collateralDecimals)) * WAD) / (amt * 10n ** 6n) : 0n
}
function calcPriceWad(totalUsdc, pAmount, pDecimals) {
  const usdc = parseSafe(totalUsdc, 6), p = parseSafe(pAmount, pDecimals)
  return p ? (usdc * (10n ** BigInt(pDecimals)) * WAD) / (p * 10n ** 6n) : 0n
}
function quoteUsdc(pAmount, pDecimals, priceWad) { return (pAmount * priceWad * 10n ** 6n) / ((10n ** BigInt(pDecimals)) * WAD) }
function status(message, bad = false) { const el = $('tx'); if (!el) return; el.className = `tx ${bad ? 'bad' : ''}`; el.innerHTML = message; el.hidden = false }
function txLink(hash) { return `<a href="${explorer(hash, 'tx')}" target="_blank">${short(hash)} on Base explorer</a>` }
async function loadAbis() {
  const names = ['SplitVaultFactory', 'SplitVault', 'LegToken', 'FixedPricePSale']
  abis = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await fetch(`/src/abi/${n}.abi.json`).then((r) => r.json())])))
}
function readOnly(address, abi) { return new Contract(address, abi, new BrowserProvider(window.ethereum || { request: ({ method }) => method === 'eth_chainId' ? '0x2105' : Promise.reject(new Error('Connect wallet or install one')) })) }
function rpcProvider() { return provider || new BrowserProvider(window.ethereum || { request: async ({ method, params }) => { const r = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result } }) }) }
async function contract(address, abi, writable = false) { return new Contract(address, abi, writable && signer ? signer : rpcProvider()) }
async function tokenInfo(address) {
  const c = await contract(address, abis.LegToken)
  const [name, symbol, decimals, balance] = await Promise.all([
    c.name().catch(() => 'Unknown token'), c.symbol().catch(() => 'TOKEN'), c.decimals().catch(() => 18n), account ? c.balanceOf(account).catch(() => 0n) : 0n,
  ])
  return { name, symbol, decimals: Number(decimals), balance }
}
async function connect() {
  if (!window.ethereum) return status('No injected wallet found.', true)
  provider = new BrowserProvider(window.ethereum)
  await provider.send('eth_requestAccounts', [])
  signer = await provider.getSigner()
  account = await signer.getAddress()
  await render()
}
async function send(label, promiseFactory) {
  try {
    status(`<strong>${label}</strong> Waiting for wallet…`)
    const tx = await promiseFactory()
    status(`<strong>${label}</strong> ${txLink(tx.hash)}`)
    await tx.wait()
    status(`<strong>${label}</strong> confirmed · ${txLink(tx.hash)}`)
    await loadMarkets(); await render()
    return tx
  } catch (e) { status(`<strong>${label}</strong> ${e.shortMessage || e.message || e}`, true); throw e }
}
async function loadMarkets() {
  const f = await contract(FACTORY_ADDRESS, abis.SplitVaultFactory)
  const len = Number(await f.allVaultsLength().catch(() => 0n))
  const plans = readPlans()
  const vaults = await Promise.all(Array.from({ length: len }, (_, i) => f.allVaults(i)))
  let allSales = []
  if (MARKETPLACE_ADDRESS) {
    const mp = await contract(MARKETPLACE_ADDRESS, abis.FixedPricePSale)
    const n = Number(await mp.salesLength().catch(() => 0n))
    allSales = await Promise.all(Array.from({ length: n }, async (_, i) => ({ id: BigInt(i), raw: await mp.sales(i) })))
  }
  markets = await Promise.all(vaults.map(async (vault) => {
    const v = await contract(vault, abis.SplitVault)
    const [collateral, pToken, nToken, maturity, exerciseDeadline, strikeWad, settled, pSupplyAtSettle, collateralPoolAtSettle, usdcPoolAtSettle] = await Promise.all([
      v.collateral(), v.P(), v.N(), v.maturity(), v.exerciseDeadline(), v.strikeWad(), v.settled(), v.pSupplyAtSettle().catch(() => 0n), v.collateralPoolAtSettle().catch(() => 0n), v.usdcPoolAtSettle().catch(() => 0n),
    ])
    const token = await tokenInfo(collateral)
    const p = await contract(pToken, abis.LegToken), n = await contract(nToken, abis.LegToken), col = await contract(collateral, abis.LegToken)
    const [pSymbol, nSymbol, pSupply, pBalance, nBalance, collateralPool] = await Promise.all([
      p.symbol().catch(() => 'P'), n.symbol().catch(() => 'N'), p.totalSupply().catch(() => 0n), account ? p.balanceOf(account).catch(() => 0n) : 0n, account ? n.balanceOf(account).catch(() => 0n) : 0n, col.balanceOf(vault).catch(() => 0n),
    ])
    const usdcOwedFull = await v.usdcOwed(pSupply || parseUnits('1', token.decimals)).catch(() => 0n)
    const sales = allSales.map((s) => ({ id: s.id, seller: s.raw[0], pToken: s.raw[1], usdc: s.raw[2], amountRemaining: s.raw[7], pricePerPTokenWad: s.raw[8], active: s.raw[9] })).filter((s) => s.active && s.amountRemaining > 0n && s.pToken.toLowerCase() === pToken.toLowerCase())
    const t = nowSec()
    let marketStatus = 'Created'
    if (settled) marketStatus = pSupply > 0n ? 'Redeemable' : 'Closed'
    else if (t > Number(exerciseDeadline)) marketStatus = 'Ready to settle'
    else if (t >= Number(maturity) && pSupply > 0n) marketStatus = 'Exercise period'
    else if (sales.length) marketStatus = 'Open for funding'
    else if (pSupply > 0n) marketStatus = 'Collateral locked'
    return { vault, collateral, pToken, nToken, maturity, exerciseDeadline, strikeWad, settled, pSupplyAtSettle, collateralPoolAtSettle, usdcPoolAtSettle, ...token, pSymbol, nSymbol, pSupply, pBalance, nBalance, collateralPool, usdcOwedFull, sales, status: marketStatus, planned: plans[vault.toLowerCase()] }
  }))
}
function marketApr(m) { return apr(Number(m.planned?.listPriceUsdc || m.planned?.targetRaiseUsdc || 0), Number(m.planned?.repayUsdc || fmt(m.usdcOwedFull, 6, 8)), nowSec(), Number(m.exerciseDeadline)) }
function marketCostApr(m) { return costApr(Number(m.planned?.listPriceUsdc || m.planned?.targetRaiseUsdc || 0) * 0.999, Number(m.planned?.repayUsdc || fmt(m.usdcOwedFull, 6, 8)), nowSec(), Number(m.exerciseDeadline)) }
function metric(label, value) { return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>` }
function addr(label, value) { return `<div class="metric"><span>${label}</span><a target="_blank" href="${explorer(value)}">${short(value)}</a></div>` }

async function render() {
  app.innerHTML = `<header class="topbar"><div><div class="eyebrow">PMFI experimental primitive</div><h1>Option-backed lending</h1><p>Borrow / Raise USDC by locking custom ERC20 collateral. Lenders buy P lender claims; borrowers keep N reclaim options. No oracle, no liquidation, no health factor.</p></div><div class="wallet-card"><div class="network">Base</div>${account ? `<strong>${short(account)}</strong>` : '<button id="connect">Connect wallet</button>'}</div></header><nav class="tabs"><button id="tabCreate" class="${activeTab === 'create' ? 'active' : ''}">Create Market</button><button id="tabMarkets" class="${activeTab === 'markets' ? 'active' : ''}">Borrow / Lend</button></nav><section id="tx" class="tx" hidden></section><div id="view"></div><div id="drawer"></div>`
  $('connect')?.addEventListener('click', connect)
  $('tabCreate').onclick = () => { activeTab = 'create'; render() }
  $('tabMarkets').onclick = () => { activeTab = 'markets'; render() }
  if (activeTab === 'create') renderCreate(); else renderMarkets()
  if (selectedMarket) renderDrawer(selectedMarket)
}
function renderCreate() {
  $('view').innerHTML = `<main class="grid create-grid">
    <section class="panel step"><h2>1. Choose collateral token</h2><label>Token contract address<input id="collateral" placeholder="0x…"></label><button id="fetchToken">Fetch token</button><div id="tokenCard" class="token-card"><strong>Token not loaded</strong></div><h3>Existing markets for same token</h3><div id="sameMarkets" class="muted">Enter a token address to check.</div></section>
    <section class="panel step"><h2>2. Choose funding terms</h2><div class="two"><label>Amount of token to lock<input id="amount" placeholder="1000"></label><label>USDC you want to raise<input id="raise" placeholder="500"></label></div><div class="two"><label>USDC you will repay<input id="repay" placeholder="550"></label><label>Repayment deadline<input id="maturity" type="datetime-local"></label></div><div class="two"><label>Reclaim window (days)<input id="window" value="7"></label><label>List P amount (% default)<input id="listPct" value="100"></label></div><details><summary>Advanced customization</summary><div class="two"><label>Final P amount to list<input id="listAmount"></label><label>Final P sale price (USDC)<input id="listPrice"></label></div><div class="two"><label>Market name prefix<input id="namePrefix" value="opl TOKEN"></label><label>Market symbol prefix<input id="symbolPrefix" value="oplTOKEN"></label></div></details></section>
    <section class="panel step preview"><h2>3. Preview</h2><div id="preview"></div><p class="notice">Vault terms are fixed after creation. P listing price is customizable until the listing is created. If you do not exercise N, P holders may redeem collateral.</p></section>
    <section class="panel step actions"><h2>4. Create vault</h2><button id="createVault">Create vault (${CREATION_FEE_ETH} ETH)</button><div id="created"></div></section>
    <section class="panel step actions"><h2>5. Lock collateral and mint P/N</h2><button id="approveCollateral">Approve collateral</button><button id="mint">Lock collateral / mint P/N</button><div id="minted"></div></section>
    <section class="panel step actions"><h2>6. List P for USDC</h2>${MARKETPLACE_ADDRESS ? '<button id="approveP">Approve P</button><button id="listP">Create sale</button>' : '<p class="notice">Marketplace contract not deployed yet. You can create markets and mint P/N now, but official P sales are disabled.</p>'}</section>
  </main>`
  let token = { symbol: 'TOKEN', decimals: 18, balance: 0n }, createdVault = '', pToken = '', nToken = ''
  const inputs = ['amount', 'raise', 'repay', 'maturity', 'window', 'listPct', 'listAmount', 'listPrice']
  const update = () => {
    const amount = $('amount').value, raise = $('raise').value, repay = $('repay').value, pct = $('listPct').value || '100'
    if (!$('listAmount').value && amount) $('listAmount').placeholder = String(Number(amount || 0) * Number(pct || 0) / 100)
    if (!$('listPrice').value) $('listPrice').placeholder = raise
    const listAmount = $('listAmount').value || $('listAmount').placeholder || '0', price = $('listPrice').value || $('listPrice').placeholder || '0'
    const deadline = $('maturity').value ? Math.floor(new Date($('maturity').value).getTime() / 1000) + Number($('window').value || 0) * 86400 : 0
    $('preview').innerHTML = metric('You lock', `${amount || 0} ${token.symbol}`) + metric('You receive', `${amount || 0} P + ${amount || 0} N`) + metric('You plan to list', `${listAmount} P`) + metric('You want to raise', `${price} USDC`) + metric('You keep', 'N reclaim option') + metric('To reclaim collateral later', `Repay ${repay || 0} USDC`) + metric('Factory creation fee', `${CREATION_FEE_ETH} ETH`) + metric('Lender max APR if exercised', `${apr(Number(price), Number(repay) * (Number(listAmount) / Number(amount || 1)), nowSec(), deadline).toFixed(2)}%`) + metric('Borrower cost APR', `${costApr(Number(price) * 0.999, Number(repay) * (Number(listAmount) / Number(amount || 1)), nowSec(), deadline).toFixed(2)}%`) + metric('No liquidation', 'No oracle, no health factor')
  }
  inputs.forEach((id) => $(id).oninput = update)
  $('fetchToken').onclick = async () => {
    const a = $('collateral').value.trim(); if (!isAddress(a)) return status('Invalid token address', true)
    token = await tokenInfo(getAddress(a)); $('tokenCard').innerHTML = `<strong>${token.name}</strong><span>${token.symbol} · ${token.decimals} decimals</span><span>Wallet balance: ${fmt(token.balance, token.decimals)} ${token.symbol}</span>`
    $('namePrefix').value = `opl ${token.symbol}`; $('symbolPrefix').value = `opl${token.symbol}`
    const same = markets.filter((m) => m.collateral.toLowerCase() === a.toLowerCase())
    $('sameMarkets').innerHTML = same.length ? same.map((m) => `<div class="mini-row"><span>${short(m.vault)}</span><b>${m.status}</b><span>${fmt(m.collateralPool, m.decimals)} locked</span></div>`).join('') : 'No matching markets found. Creating another market for the same token is allowed.'
    update()
  }
  $('createVault').onclick = async () => {
    const collateral = getAddress($('collateral').value), maturity = Math.floor(new Date($('maturity').value).getTime() / 1000), exerciseWindow = BigInt(Number($('window').value || 0) * 86400)
    const f = await contract(FACTORY_ADDRESS, abis.SplitVaultFactory, true)
    const strike = calcStrikeWad($('repay').value, $('amount').value, token.decimals)
    const tx = await send('Create vault', () => f.createVault(collateral, BASE_USDC, strike, BigInt(maturity), exerciseWindow, $('namePrefix').value, $('symbolPrefix').value, { value: parseEther(CREATION_FEE_ETH) }))
    const len = Number(await f.allVaultsLength()); createdVault = await f.allVaults(len - 1); const v = await contract(createdVault, abis.SplitVault)
    pToken = await v.P(); nToken = await v.N(); writePlan(createdVault, { collateralAmount: $('amount').value, targetRaiseUsdc: $('raise').value, repayUsdc: $('repay').value, listPercent: $('listPct').value, listPAmount: $('listAmount').value || $('listAmount').placeholder, listPriceUsdc: $('listPrice').value || $('listPrice').placeholder, namePrefix: $('namePrefix').value, symbolPrefix: $('symbolPrefix').value })
    $('created').innerHTML = `<div class="result"><span>Market created</span><a target="_blank" href="${explorer(createdVault)}">${createdVault}</a><span>${txLink(tx.hash)}</span></div>`
  }
  $('approveCollateral').onclick = async () => { const c = await contract(getAddress($('collateral').value), abis.LegToken, true); await send('Approve collateral', () => c.approve(createdVault, parseSafe($('amount').value, token.decimals))) }
  $('mint').onclick = async () => { const v = await contract(createdVault, abis.SplitVault, true); await send('Lock collateral and mint P/N', () => v.mint(parseSafe($('amount').value, token.decimals))); const p = await contract(pToken, abis.LegToken), n = await contract(nToken, abis.LegToken); $('minted').innerHTML = addr('P token', pToken) + addr('N token', nToken) + metric('P balance', fmt(await p.balanceOf(account), token.decimals)) + metric('N balance', fmt(await n.balanceOf(account), token.decimals)) }
  update()
}
function renderMarkets() {
  const groups = markets.reduce((m, x) => ((m[x.collateral.toLowerCase()] ||= []).push(x), m), {})
  $('view').innerHTML = `<main class="panel markets"><div class="markets-head"><div><h2>Borrow / Lend</h2><p>All vaults from the factory grouped by collateral token. Creating a vault is not active lending; funding begins when P is sold for USDC.</p></div><button id="refresh">Refresh markets</button></div><div id="groups">${Object.values(groups).length ? Object.values(groups).map(groupHtml).join('') : '<p class="muted">No vaults found from the factory yet.</p>'}</div></main>`
  $('refresh').onclick = async () => { status('Refreshing markets…'); await loadMarkets(); render() }
  document.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => { selectedMarket = markets.find((m) => m.vault === b.dataset.open); renderDrawer(selectedMarket) })
  document.querySelectorAll('.group-row').forEach((b) => b.onclick = () => b.parentElement.classList.toggle('open'))
}
function groupHtml(items) {
  const f = items[0], total = items.reduce((a, m) => a + m.collateralPool, 0n), next = items.map((m) => m.maturity).filter(Boolean).sort((a,b)=>Number(a-b))[0]
  return `<section class="token-group open"><button class="group-row"><strong>${f.symbol}</strong><span>${short(f.collateral)}</span><span>${items.length} markets</span><span>${fmt(total, f.decimals)} locked</span><span>Next expiry ${date(next)}</span><span>Best max APR ${Math.max(0, ...items.map(marketApr)).toFixed(2)}%</span><b>Expand/collapse</b></button><div class="table"><div class="thead"><span>Vault</span><span>Status</span><span>Collateral locked</span><span>P supply</span><span>Planned/listed raise</span><span>Repay</span><span>Maturity</span><span>Exercise deadline</span><span>Max APR</span><span>Borrower APR</span><span>Action</span></div>${items.map(rowHtml).join('')}</div></section>`
}
function rowHtml(m) {
  const listed = m.sales.reduce((a, s) => a + quoteUsdc(s.amountRemaining, m.decimals, s.pricePerPTokenWad), 0n)
  const action = m.sales.length ? 'Fund / Buy P' : (m.nBalance > 0n && nowSec() >= Number(m.maturity) && nowSec() <= Number(m.exerciseDeadline) ? 'Repay to reclaim' : (nowSec() > Number(m.exerciseDeadline) && !m.settled ? 'Settle' : (m.pBalance > 0n && m.settled ? 'Redeem P' : (m.pBalance > 0n && MARKETPLACE_ADDRESS ? 'List P' : 'View details'))))
  return `<div class="trow"><span><a href="${explorer(m.vault)}" target="_blank">${short(m.vault)}</a></span><span><b>${m.status}</b></span><span>${fmt(m.collateralPool, m.decimals)} ${m.symbol}</span><span>${fmt(m.pSupply, m.decimals)} ${m.pSymbol}</span><span>${listed ? fmt(listed, 6) : (m.planned?.targetRaiseUsdc || '—')} USDC</span><span>${m.planned?.repayUsdc || fmt(m.usdcOwedFull, 6)} USDC</span><span>${date(m.maturity)}</span><span>${date(m.exerciseDeadline)}</span><span>${marketApr(m).toFixed(2)}%</span><span>${marketCostApr(m).toFixed(2)}%</span><button data-open="${m.vault}">${action}</button></div>`
}
function renderDrawer(m) {
  if (!m) return
  $('drawer').innerHTML = `<aside class="drawer"><div class="drawer-card"><button id="closeDrawer" class="close">×</button><h2>${m.symbol} market ${short(m.vault)}</h2><section><h3>1. Overview</h3><div class="metrics">${metric('Status', m.status)}${metric('Collateral fallback', `${fmt(m.collateralPool, m.decimals)} ${m.symbol}`)}${metric('P = lender claim', `${fmt(m.pSupply, m.decimals)} supply`)}${metric('N = reclaim option', `${fmt(m.nBalance, m.decimals)} in wallet`)}${metric('Max APR if exercised', `${marketApr(m).toFixed(2)}%`)}${metric('Borrower cost APR', `${marketCostApr(m).toFixed(2)}%`)}</div></section><section><h3>2. Borrower actions</h3><div class="action-grid"><label>Collateral amount<input id="drawerCollateral" value="${m.planned?.collateralAmount || ''}"></label><button id="drawerApproveCollateral">Approve collateral</button><button id="drawerMint">Mint P/N</button></div><div class="action-grid"><label>Edit planned P listing<input id="drawerPAmount" value="${m.planned?.listPAmount || fmt(m.pBalance, m.decimals, 8)}"></label><label>USDC sale price<input id="drawerPPrice" value="${m.planned?.listPriceUsdc || m.planned?.targetRaiseUsdc || ''}"></label><button id="drawerApproveP" ${MARKETPLACE_ADDRESS ? '' : 'disabled'}>Approve P</button><button id="drawerListP" ${MARKETPLACE_ADDRESS ? '' : 'disabled'}>${MARKETPLACE_ADDRESS ? 'List P for USDC' : 'P sales disabled'}</button></div><div class="action-grid"><label>N amount to exercise<input id="drawerNAmount" value="${fmt(m.nBalance, m.decimals, 8)}"></label><button id="drawerApproveUsdc">Approve USDC</button><button id="drawerExercise">Repay to reclaim collateral</button></div></section><section><h3>3. Lender actions</h3>${MARKETPLACE_ADDRESS ? (m.sales.map((s) => `<div class="sale">${metric('Active P listing', `#${s.id} · ${fmt(s.amountRemaining, m.decimals)} P`)}${metric('Price', `${fmt(quoteUsdc(s.amountRemaining, m.decimals, s.pricePerPTokenWad), 6)} USDC`)}${metric('Collateral fallback', `${fmt(m.collateralPool, m.decimals)} ${m.symbol}`)}<button data-buy="${s.id}">Lend / Fund market</button></div>`).join('') || '<p class="muted">No active listings.</p>') : '<p class="notice">Marketplace contract not deployed yet. Official P sales are disabled.</p>'}<div class="action-grid"><label>P amount to redeem<input id="drawerRedeem" value="${fmt(m.pBalance, m.decimals, 8)}"></label><button id="drawerSettle">Settle if available</button><button id="drawerRedeemBtn">Redeem lender claim</button></div></section><section><h3>4. Advanced</h3><div class="advanced">${addr('Factory address', FACTORY_ADDRESS)}${addr('Vault address', m.vault)}${addr('Collateral address', m.collateral)}${addr('USDC address', BASE_USDC)}${addr('P token address', m.pToken)}${addr('N token address', m.nToken)}${metric('raw strikeWad', String(m.strikeWad))}${metric('raw maturity timestamp', String(m.maturity))}${metric('raw exerciseDeadline timestamp', String(m.exerciseDeadline))}${metric('raw balances', `P ${m.pBalance}, N ${m.nBalance}, collateral ${m.collateralPool}`)}</div></section></div></aside>`
  $('closeDrawer').onclick = () => { selectedMarket = null; $('drawer').innerHTML = '' }
  $('drawerApproveCollateral').onclick = async () => { const c = await contract(m.collateral, abis.LegToken, true); await send('Approve collateral', () => c.approve(m.vault, parseSafe($('drawerCollateral').value, m.decimals))) }
  $('drawerMint').onclick = async () => { const v = await contract(m.vault, abis.SplitVault, true); await send('Mint P/N', () => v.mint(parseSafe($('drawerCollateral').value, m.decimals))) }
  if (MARKETPLACE_ADDRESS) {
    $('drawerApproveP').onclick = async () => { const p = await contract(m.pToken, abis.LegToken, true); await send('Approve P lender claim', () => p.approve(MARKETPLACE_ADDRESS, parseSafe($('drawerPAmount').value, m.decimals))) }
    $('drawerListP').onclick = async () => { const mp = await contract(MARKETPLACE_ADDRESS, abis.FixedPricePSale, true); await send('List P for USDC', () => mp.createSale(m.pToken, BASE_USDC, parseSafe($('drawerPAmount').value, m.decimals), calcPriceWad($('drawerPPrice').value, $('drawerPAmount').value, m.decimals))) }
    document.querySelectorAll('[data-buy]').forEach((b) => b.onclick = async () => { const sale = m.sales.find((s) => String(s.id) === b.dataset.buy); if (!sale) return; const mp = await contract(MARKETPLACE_ADDRESS, abis.FixedPricePSale, true); await send('Lend / Fund market', () => mp.buy(sale.id, sale.amountRemaining)) })
  }
  $('drawerApproveUsdc').onclick = async () => { const u = await contract(BASE_USDC, abis.LegToken, true); const amt = parseSafe($('drawerNAmount').value, m.decimals); const owed = (amt * m.strikeWad * 10n ** 6n) / ((10n ** BigInt(m.decimals)) * WAD); await send('Approve USDC', () => u.approve(m.vault, owed)) }
  $('drawerExercise').onclick = async () => { const v = await contract(m.vault, abis.SplitVault, true); await send('Exercise N / repay', () => v.exercise(parseSafe($('drawerNAmount').value, m.decimals))) }
  $('drawerSettle').onclick = async () => { const v = await contract(m.vault, abis.SplitVault, true); await send('Settle vault', () => v.settle()) }
  $('drawerRedeemBtn').onclick = async () => { const v = await contract(m.vault, abis.SplitVault, true); await send('Redeem lender claim', () => v.redeemP(parseSafe($('drawerRedeem').value, m.decimals))) }
}

await loadAbis()
if (window.ethereum) {
  provider = new BrowserProvider(window.ethereum)
  const accounts = await provider.send('eth_accounts', []).catch(() => [])
  if (accounts[0]) { signer = await provider.getSigner(); account = await signer.getAddress() }
}
await loadMarkets().catch((e) => console.warn(e))
await render()
