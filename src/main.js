import { BrowserProvider, Contract, Interface, formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm'
import { CONFIG } from './config.js'
import { CANDIDATE_COLLATERAL } from './collateralRegistry.js'
import { escapeHtml as e, sanitizeError, shortAddress, formatDate, money } from './format.js'
import { LIMITS, validateBorrowForm, isWriteDisabled } from './validation.js'
import { pAmountForBudget } from './quotes.js'
import { fallbackProvider, readContract, writeContract, explorerLink } from './contracts.js'

const app = document.getElementById('app')
const $ = (id) => document.getElementById(id)
const STORAGE_KEY = 'pmfi-v22-borrow-draft'
const MAX_VAULT_READS = 4
const ZERO = '0x0000000000000000000000000000000000000000'

let browserProvider
let signer
let account = ''
let chainId = 0
let activeTab = 'borrow'
let selectedLendId = ''
let notice = ''
let noticeDanger = false
let pending = false
let loadingPositions = true
let loadError = ''
let partialWarning = ''
let markets = []
let registryState = []
let factoryState = { creationPaused: false, purchasesPaused: false, creationFee: CONFIG.CREATION_FEE_WEI, minFunding: BigInt(LIMITS.MIN_FUNDING_SECONDS), maxFunding: BigInt(LIMITS.MAX_FUNDING_SECONDS), maxRepayment: BigInt(LIMITS.MAX_REPAYMENT_SECONDS) }
let token = null
let borrowResult = null

const factoryIface = new Interface(CONFIG.ABIS.factory)

function fmt(value, decimals = 18, max = 4) {
  try {
    const raw = typeof value === 'bigint' ? formatUnits(value, decimals) : String(value || '0')
    const n = Number(raw)
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: max }) : raw
  } catch { return '0' }
}
function parseAmount(value, decimals) { try { return value && Number(value) > 0 ? parseUnits(String(value), decimals) : 0n } catch { return 0n } }
function nowSec() { return Math.floor(Date.now() / 1000) }
function secondsFromDays(days) { return Math.max(1, Number(days)) * 86400 }
function apr(investment, payoff, start, end) { return investment > 0 && payoff > investment && end > start ? ((payoff - investment) / investment) * (31536000 / (end - start)) * 100 : 0 }
function isBase() { return chainId === CONFIG.BASE_CHAIN_ID }
function providerForReads() { return browserProvider || fallbackProvider() }
function factory(readonly = true) { return new Contract(CONFIG.FACTORY_ADDRESS, CONFIG.ABIS.factory, readonly || !signer ? providerForReads() : signer) }
function marketplace(readonly = true) { return new Contract(CONFIG.MARKETPLACE_ADDRESS, CONFIG.ABIS.marketplace, readonly || !signer ? providerForReads() : signer) }
function vaultContract(address, readonly = true) { return new Contract(address, CONFIG.ABIS.vault, readonly || !signer ? providerForReads() : signer) }
function erc20(address, readonly = true) { return new Contract(address, CONFIG.ABIS.erc20, readonly || !signer ? providerForReads() : signer) }
function txLink(hash) { return `<a target="_blank" rel="noopener noreferrer" href="${explorerLink(hash, 'tx')}">${shortAddress(hash)}</a>` }
function addressLink(address) { return `<a target="_blank" rel="noopener noreferrer" href="${explorerLink(address)}">${shortAddress(address)}</a>` }
function setNotice(message, danger = false) { notice = message; noticeDanger = danger; const el = $('notice'); if (el) { el.hidden = false; el.className = `notice ${danger ? 'danger' : ''}`; el.innerHTML = message } }
function setNoticeText(message, danger = false) { setNotice(e(message), danger) }
function clearNotice() { notice = ''; const el = $('notice'); if (el) el.hidden = true }
function tokenIcon(kind = 'custom') { return `<span class="token-icon ${e(kind)}">${kind === 'arb' ? '◢' : kind === 'op' ? 'OP' : kind === 'uni' ? '◇' : kind === 'aave' ? 'A' : '•'}</span>` }
function infoTip() { return '<span class="info">i</span>' }
function saveDraft() {
  const ids = ['collateral', 'lockAmount', 'raiseUsdc', 'repayUsdc', 'fundingHours', 'repaymentDays', 'namePrefix', 'symbolPrefix']
  const draft = Object.fromEntries(ids.map((id) => [id, $(id)?.value || '']))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
}
function readDraft() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
function saleTuple(s) { return { vault: s.vault ?? s[0], seller: s.seller ?? s[1], pToken: s.pToken ?? s[2], amountInitial: s.amountInitial ?? s[3], amountRemaining: s.amountRemaining ?? s[4], usdcTotal: s.usdcTotal ?? s[5], usdcRemaining: s.usdcRemaining ?? s[6], usdcRaisedToSeller: s.usdcRaisedToSeller ?? s[7], feeAccrued: s.feeAccrued ?? s[8], expiry: s.expiry ?? s[9], active: s.active ?? s[10] } }
function parsePositionCreated(receipt) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== CONFIG.FACTORY_ADDRESS.toLowerCase()) continue
    try {
      const parsed = factoryIface.parseLog(log)
      if (parsed?.name === 'PositionCreated') return parsed.args
    } catch {}
  }
  throw new Error('PositionCreated event not found in receipt')
}
async function sendTx(label, action) {
  if (pending) return
  pending = true
  try {
    setNotice(`<strong>${e(label)}</strong> preparing…`)
    const tx = await action((phase) => setNotice(`<strong>${e(label)}</strong> ${e(phase)}`))
    setNotice(`<strong>${e(label)}</strong> submitted ${txLink(tx.hash)}. Awaiting confirmation…`)
    const receipt = await tx.wait()
    setNotice(`<strong>${e(label)}</strong> confirmed ${txLink(tx.hash)}.`)
    await refreshAll()
    return { tx, receipt }
  } catch (error) {
    setNotice(`<strong>${e(label)}</strong> failed: ${sanitizeError(error)}`, true)
    throw error
  } finally {
    pending = false
    render()
  }
}

async function connect() {
  if (!window.ethereum) return setNoticeText('No injected wallet found. Install a wallet to write transactions.', true)
  browserProvider = new BrowserProvider(window.ethereum)
  await browserProvider.send('eth_requestAccounts', [])
  signer = await browserProvider.getSigner()
  account = await signer.getAddress()
  chainId = Number((await browserProvider.getNetwork()).chainId)
  await refreshAll()
  await render()
}
async function switchToBase() {
  if (!window.ethereum) return
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.BASE_CHAIN_HEX }] }) }
  catch (error) {
    if (error.code === 4902) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CONFIG.BASE_CHAIN_HEX, chainName: 'Base Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CONFIG.BASE_RPC], blockExplorerUrls: [CONFIG.EXPLORER_URL] }] })
    } else throw error
  }
}
function setupWalletEvents() {
  if (!window.ethereum) return
  window.ethereum.on?.('accountsChanged', async (accounts) => { account = accounts?.[0] ? getAddress(accounts[0]) : ''; signer = account && browserProvider ? await browserProvider.getSigner() : undefined; token = null; await refreshAll(); await render() })
  window.ethereum.on?.('chainChanged', async () => { browserProvider = new BrowserProvider(window.ethereum); signer = account ? await browserProvider.getSigner() : undefined; chainId = Number((await browserProvider.getNetwork()).chainId); token = null; await refreshAll(); await render() })
}

async function refreshRegistry() {
  const f = factory(true)
  registryState = await Promise.all(CANDIDATE_COLLATERAL.map(async (candidate) => ({ ...candidate, allowed: await f.collateralAllowed(candidate.address).catch(() => false) })))
}
async function refreshFactoryState() {
  const f = factory(true)
  const [creationPaused, purchasesPaused, creationFee, minFunding, maxFunding, maxRepayment] = await Promise.all([
    f.creationPaused(), f.purchasesPaused(), f.CREATION_FEE(), f.MIN_FUNDING_PERIOD(), f.MAX_FUNDING_PERIOD(), f.MAX_REPAYMENT_PERIOD(),
  ])
  factoryState = { creationPaused, purchasesPaused, creationFee, minFunding, maxFunding, maxRepayment }
}
async function mapLimit(items, limit, fn) {
  const out = []
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
async function loadVault(vaultAddress) {
  const f = factory(true)
  if (!(await f.isVault(vaultAddress))) throw new Error('Unregistered vault')
  const v = vaultContract(vaultAddress, true)
  const [borrower, collateral, usdc, pToken, nToken, cDec, uDec, initialCollateralAmount, targetRaiseUsdc, totalRepaymentUsdc, fundingDeadline, repaymentDeadline, initialized, fundingClosed, settled, closedWithoutOutstandingP, pairedN, exercisedN, usdcPaid, accountedCollateral, collateralRefundClaim, repaymentRequiredUsdc, repaymentRemainingUsdc, canSettleEarly] = await Promise.all([
    v.borrower(), v.collateral(), v.usdc(), v.P(), v.N(), v.collateralDecimals(), v.usdcDecimals(), v.initialCollateralAmount(), v.targetRaiseUsdc(), v.totalRepaymentUsdc(), v.fundingDeadline(), v.repaymentDeadline(), v.initialized(), v.fundingClosed(), v.settled(), v.closedWithoutOutstandingP(), v.pairedN(), v.exercisedN(), v.usdcPaid(), v.accountedCollateral(), v.collateralRefundClaim(), v.repaymentRequiredUsdc(), v.repaymentRemainingUsdc(), v.canSettleEarly().catch(() => false),
  ])
  const c = erc20(collateral, true), p = erc20(pToken, true), n = erc20(nToken, true)
  const [symbol, name, pSupply, pBalance, nBalance] = await Promise.all([
    c.symbol().catch(() => 'TOKEN'), c.name().catch(() => 'Custom token'), p.totalSupply().catch(() => 0n), account ? p.balanceOf(account).catch(() => 0n) : 0n, account ? n.balanceOf(account).catch(() => 0n) : 0n,
  ])
  const saleIdPlusOne = await marketplace(true).saleIdPlusOneByVault(vaultAddress).catch(() => 0n)
  const saleId = saleIdPlusOne > 0n ? saleIdPlusOne - 1n : null
  const sale = saleId !== null ? saleTuple(await marketplace(true).sales(saleId)) : null
  let preview = { collateralOut: 0n, usdcOut: 0n }
  if (settled && pBalance > 0n) { try { const r = await v.previewRedeemP(pBalance); preview = { collateralOut: r[0], usdcOut: r[1] } } catch {} }
  const funded = initialCollateralAmount > 0n ? initialCollateralAmount - (sale?.amountRemaining || 0n) : 0n
  return { id: vaultAddress, vault: vaultAddress, borrower, collateral, usdc, pToken, nToken, token: symbol, name, logo: 'custom', decimals: Number(cDec), usdcDecimals: Number(uDec), initialCollateralAmount, targetRaiseUsdc, totalRepaymentUsdc, fundingDeadline, repaymentDeadline, initialized, fundingClosed, settled, closedWithoutOutstandingP, pairedN, exercisedN, usdcPaid, accountedCollateral, collateralRefundClaim, repaymentRequiredUsdc, repaymentRemainingUsdc, canSettleEarly, pSupply, pBalance, nBalance, saleId, sale, preview, funded }
}
async function loadPositions() {
  loadingPositions = true; loadError = ''; partialWarning = ''
  try {
    const f = factory(true)
    const len = Number(await f.allVaultsLength())
    const vaults = await Promise.all(Array.from({ length: len }, (_, i) => f.allVaults(i)))
    const settled = await mapLimit(vaults, MAX_VAULT_READS, async (vaultAddress) => loadVault(vaultAddress).catch((error) => ({ error, vaultAddress })))
    const failures = settled.filter((x) => x?.error)
    markets = settled.filter((x) => !x?.error)
    if (failures.length) partialWarning = `${failures.length} position${failures.length === 1 ? '' : 's'} could not be loaded from the public RPC.`
  } catch (error) {
    loadError = sanitizeError(error)
    markets = []
  } finally { loadingPositions = false }
}
async function refreshAll() {
  try { await refreshFactoryState() } catch (error) { loadError = sanitizeError(error) }
  try { await refreshRegistry() } catch {}
  await loadPositions()
}

function liveOpenMarkets() {
  const t = BigInt(nowSec())
  return markets.filter((m) => m.sale && m.sale.active && m.sale.amountRemaining > 0n && m.fundingDeadline > t && !m.fundingClosed && !m.settled)
}
function selectedMarket() { return liveOpenMarkets().find((m) => m.id === selectedLendId) || liveOpenMarkets()[0] }
function tabCopy() {
  if (activeTab === 'borrow') return 'Raise USDC by locking token collateral. No oracle. No liquidation. Fixed repayment.'
  if (activeTab === 'lend') return 'Lend USDC into fixed repayment positions. If repaid, earn fixed yield. If unpaid, claim collateral fallback.'
  return 'Track your borrow positions and lender positions in one place.'
}
function renderNotice() {
  const wrong = account && !isBase()
  const warning = wrong ? `<div class="notice danger"><strong>Wrong network.</strong> Switch to Base Mainnet to write transactions. <button id="switchBase" class="link-btn">Switch to Base</button></div>` : ''
  return `${warning}<div id="notice" class="notice ${noticeDanger ? 'danger' : ''}" ${notice ? '' : 'hidden'}>${notice}</div>${loadError ? `<div class="notice danger"><strong>RPC error.</strong> ${loadError} <button id="retryLoad" class="link-btn">Retry</button></div>` : ''}${partialWarning ? `<div class="notice"><strong>Partial data.</strong> ${e(partialWarning)} <button id="retryLoad2" class="link-btn">Retry</button></div>` : ''}`
}
async function render() {
  try {
    app.innerHTML = `<div class="shell"><header class="topbar"><p>${e(tabCopy())}</p><button id="connect" class="connect">${account ? e(shortAddress(account)) : 'Connect wallet'}</button></header><nav class="tabs" aria-label="Main tabs"><button data-tab="borrow" class="${activeTab === 'borrow' ? 'active' : ''}">Borrow</button><button data-tab="lend" class="${activeTab === 'lend' ? 'active' : ''}">Lend</button><button data-tab="portfolio" class="${activeTab === 'portfolio' ? 'active' : ''}">Portfolio</button></nav>${renderNotice()}<main id="view"></main></div>`
    $('connect').onclick = connect
    $('switchBase')?.addEventListener('click', switchToBase)
    $('retryLoad')?.addEventListener('click', async () => { await refreshAll(); render() })
    $('retryLoad2')?.addEventListener('click', async () => { await refreshAll(); render() })
    document.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => { activeTab = button.dataset.tab; render() })
    if (activeTab === 'borrow') renderBorrow()
    if (activeTab === 'lend') renderLend()
    if (activeTab === 'portfolio') renderPortfolio()
  } catch (error) {
    app.innerHTML = `<div class="shell"><div class="notice danger"><strong>UI recovered from an error.</strong> ${sanitizeError(error)}</div><button class="connect" onclick="location.reload()">Reload</button></div>`
  }
}

function registryHtml() {
  const section = (title, allowed) => `<div class="registry-section"><h3>${title}</h3>${registryState.filter((c) => c.allowed === allowed).map((c) => `<button class="registry-token" data-token="${e(c.address)}" ${allowed ? '' : 'disabled'}><strong>${e(c.symbol)}</strong><small>${e(c.category)} · ${e(c.reviewStatus)}${c.minimumMarketCap ? ` · screening ${e(c.minimumMarketCap)}` : ''}</small><span>${allowed ? 'Enabled by factory' : 'Under review'}</span></button>`).join('') || '<p class="hint">No tokens in this section.</p>'}</div>`
  return `<div class="registry-grid">${section('Enabled collateral', true)}${section('Under review', false)}</div>`
}
function renderBorrow() {
  const draft = readDraft()
  $('view').innerHTML = `<section class="borrow-layout"><div class="card form-card"><div class="card-head"><h2>Create borrow position</h2><span>V2.2 Base</span></div><label>Reviewed collateral</label>${registryHtml()}<label>Collateral token</label><div class="search-input"><span>⌕</span><input id="collateral" placeholder="Paste token contract address" value="${e(draft.collateral || '')}"><button id="fetchToken" class="fetch-btn">Fetch</button></div><div id="tokenBox" class="token-summary" hidden></div><label>Amount to lock <strong id="amountLabel" class="term-label">0%</strong></label><div class="amount-row"><input id="lockAmount" placeholder="0.00" value="${e(draft.lockAmount || '')}"></div><input id="amountPercent" type="range" min="0" max="100" value="0"><div class="two-cols"><label>USDC to raise ${infoTip()}<div class="unit-input"><input id="raiseUsdc" placeholder="0" value="${e(draft.raiseUsdc || '')}"><span>USDC</span></div></label><label>Total repayment ${infoTip()}<div class="unit-input"><input id="repayUsdc" placeholder="0" value="${e(draft.repayUsdc || '')}"><span>USDC</span></div></label></div><div class="two-cols"><label>Funding window ${infoTip()} <strong id="fundingLabel" class="term-label">24 hours</strong><input id="fundingHours" type="range" min="1" max="720" value="${e(draft.fundingHours || '24')}"></label><label>Repayment window ${infoTip()} <strong id="repaymentLabel" class="term-label">180 days</strong><input id="repaymentDays" type="range" min="1" max="365" value="${e(draft.repaymentDays || '180')}"></label></div><div class="two-cols"><label>Name prefix<div class="unit-input"><input id="namePrefix" maxlength="32" placeholder="opl TOKEN" value="${e(draft.namePrefix || '')}"></div></label><label>Symbol prefix<div class="unit-input"><input id="symbolPrefix" maxlength="32" placeholder="oplTOKEN" value="${e(draft.symbolPrefix || '')}"></div></label></div><div id="borrowProgress" class="tx-steps" hidden></div><button id="createBorrow" class="primary-action">Create borrow position</button><p class="fee-note">Factory creation fee ${CONFIG.CREATION_FEE_ETH} ETH ${infoTip()}</p></div><aside><div class="card preview-card"><h2>Position preview</h2><div id="borrowPreview"></div><div class="important">${infoTip()}<div><strong>Important</strong><p>If the sale is only partially filled, your required repayment is reduced according to the P amount actually funded.</p></div></div><div id="borrowResult"></div></div><div class="card split-card"><h2>How it works</h2>${splitModule('borrow')}</div></aside></section>`
  document.querySelectorAll('[data-token]').forEach((b) => b.onclick = () => { $('collateral').value = b.dataset.token; fetchToken() })
  const update = () => {
    const fundingHours = Number($('fundingHours').value || 24), repaymentDays = Number($('repaymentDays').value || 180)
    const fundingDeadline = nowSec() + fundingHours * 3600
    const repaymentDeadline = fundingDeadline + secondsFromDays(repaymentDays)
    $('fundingLabel').textContent = `${fundingHours} ${fundingHours === 1 ? 'hour' : 'hours'}`
    $('repaymentLabel').textContent = `${repaymentDays} ${repaymentDays === 1 ? 'day' : 'days'}`
    $('amountLabel').textContent = `${$('amountPercent').value || 0}%`
    const symbol = token?.symbol || 'TOKEN'
    $('borrowPreview').innerHTML = previewRows([
      ['Collateral locked', `${e(money($('lockAmount').value || 0))} ${e(symbol)}`], ['Target USDC raise', `${e(money($('raiseUsdc').value || 0))} USDC`], ['Total repayment', `${e(money($('repayUsdc').value || 0))} USDC`], ['Funding deadline', formatDate(fundingDeadline)], ['Repayment deadline', formatDate(repaymentDeadline)], ['You keep', 'N reclaim right'], ['Default outcome', 'Lender can redeem funded collateral'], ['Creation fee', `${CONFIG.CREATION_FEE_ETH} ETH`],
    ])
    saveDraft()
  }
  async function fetchToken() {
    try {
      const input = $('collateral').value.trim()
      if (!isAddress(input)) return setNoticeText('Enter a valid ERC20 contract address.', true)
      if (!account) return setNoticeText('Connect wallet first so the app can fetch your token balance.', true)
      const address = getAddress(input)
      const c = readContract(address, CONFIG.ABIS.erc20, providerForReads())
      const [symbol, name, decimals, balance, allowed] = await Promise.all([c.symbol().catch(() => 'TOKEN'), c.name().catch(() => 'Custom token'), c.decimals().catch(() => 18n), c.balanceOf(account).catch(() => 0n), factory(true).collateralAllowed(address).catch(() => false)])
      token = { address, symbol: String(symbol), name: String(name), decimals: Number(decimals), balance, allowed, isUsdc: address.toLowerCase() === CONFIG.BASE_USDC.toLowerCase() }
      $('tokenBox').hidden = false
      $('tokenBox').innerHTML = `<div><strong>${e(token.symbol)}</strong><small>${e(token.name)}</small></div><div class="balance"><small>Wallet balance</small><strong>${e(fmt(balance, token.decimals, 8))}</strong><span class="status-pill ${allowed ? 'ok' : 'review'}">${allowed ? 'Enabled by factory' : 'Under review / disabled'}</span></div>`
      $('namePrefix').value ||= `opl ${token.symbol}`.slice(0, 32)
      $('symbolPrefix').value ||= `opl${token.symbol}`.slice(0, 32)
      update()
    } catch (error) { setNotice(`<strong>Fetch token</strong> failed: ${sanitizeError(error)}`, true) }
  }
  $('fetchToken').onclick = fetchToken
  $('amountPercent').oninput = () => { if (token) $('lockAmount').value = fmt((token.balance * BigInt($('amountPercent').value || 0)) / 100n, token.decimals, 8); update() }
  ;['lockAmount', 'raiseUsdc', 'repayUsdc', 'fundingHours', 'repaymentDays', 'namePrefix', 'symbolPrefix'].forEach((id) => $(id).oninput = update)
  $('createBorrow').onclick = async () => createBorrowPosition(update)
  if (borrowResult) $('borrowResult').innerHTML = borrowResult
  update()
}
async function createBorrowPosition(update) {
  if (!token) return setNoticeText('Fetch an enabled collateral token first.', true)
  const collateralAmount = parseAmount($('lockAmount').value, token.decimals)
  const targetRaise = parseAmount($('raiseUsdc').value, 6)
  const totalRepayment = parseAmount($('repayUsdc').value, 6)
  const fundingSeconds = Number($('fundingHours').value || 24) * 3600
  const repaymentSeconds = secondsFromDays($('repaymentDays').value || 180)
  const ethBalance = account && browserProvider ? await browserProvider.getBalance(account).catch(() => 0n) : 0n
  const errors = validateBorrowForm({ connected: Boolean(account), wrongNetwork: account && !isBase(), creationPaused: factoryState.creationPaused, collateralAllowed: token.allowed, collateralIsUsdc: token.isUsdc, collateralAmount, targetRaise, totalRepayment, fundingSeconds, repaymentSeconds, namePrefix: $('namePrefix').value, symbolPrefix: $('symbolPrefix').value, decimals: token.decimals, balance: token.balance, ethBalance })
  if (errors.length) return setNoticeText(errors.join('; '), true)
  const progress = $('borrowProgress'); progress.hidden = false; progress.innerHTML = '<span>Step 1: Approve collateral — pending</span><span>Step 2: Create position — waiting</span>'
  const collateral = erc20(token.address, false)
  const allowance = await collateral.allowance(account, CONFIG.FACTORY_ADDRESS)
  if (allowance < collateralAmount) {
    await sendTx('Approve collateral', async (phase) => { phase('awaiting wallet confirmation…'); return collateral.approve(CONFIG.FACTORY_ADDRESS, collateralAmount) })
    const reread = await erc20(token.address, true).allowance(account, CONFIG.FACTORY_ADDRESS)
    if (reread < collateralAmount) return setNoticeText('Approval was not sufficient after confirmation.', true)
  }
  progress.innerHTML = '<span>Step 1: Approve collateral — complete</span><span>Step 2: Create position — pending</span>'
  const fundingDeadline = BigInt(nowSec() + fundingSeconds)
  const repaymentDeadline = fundingDeadline + BigInt(repaymentSeconds)
  const params = { collateral: token.address, collateralAmount, targetRaiseUsdc: targetRaise, totalRepaymentUsdc: totalRepayment, fundingDeadline, repaymentDeadline, namePrefix: $('namePrefix').value, symbolPrefix: $('symbolPrefix').value }
  const result = await sendTx('Create position', async (phase) => { phase('awaiting wallet confirmation…'); return factory(false).createPosition(params, { value: CONFIG.CREATION_FEE_WEI }) })
  const event = parsePositionCreated(result.receipt)
  borrowResult = `<div class="result-links"><strong>Created position</strong><span>Vault ${addressLink(event.vault)}</span><span>P token ${addressLink(event.pToken)}</span><span>N token ${addressLink(event.nToken)}</span><span>Sale ID ${e(event.saleId.toString())}</span><span>Tx ${txLink(result.tx.hash)}</span></div>`
  localStorage.removeItem(STORAGE_KEY)
  update()
}

function renderLend() {
  const rows = liveOpenMarkets()
  const selected = selectedMarket()
  $('view').innerHTML = `<section class="lend-layout"><div class="card table-card"><h2>Open lend positions</h2><div class="table-tools"><div class="search-input"><span>⌕</span><input placeholder="Search token"></div><button class="sort">Estimated APR ⌄</button></div><div class="market-table"><div class="thead"><span>Collateral</span><span>Raise</span><span>Repay</span><span>Funding</span><span>Estimated APR</span><span>Available</span><span>Action</span></div>${loadingPositions ? '<div class="empty-state">Loading live positions…</div>' : rows.length ? rows.map(lendRow).join('') : '<div class="empty-state">No live lend listings found yet.</div>'}</div></div><aside><div class="card action-card" id="lendPreview"></div><div class="card split-card"><h2>How it works</h2>${splitModule('lend')}</div></aside></section>`
  document.querySelectorAll('[data-select-market]').forEach((b) => b.onclick = () => { selectedLendId = b.dataset.selectMarket; renderLend() })
  $('lendPreview').innerHTML = selected ? lendPreview(selected) : '<h2>Lend into position</h2><p class="hint">Live V2.2 P listings will appear here once available.</p>'
  $('fundPosition')?.addEventListener('click', () => fundSelected(selected))
  $('budgetUsdc')?.addEventListener('input', () => updateBudgetQuote(selected))
}
function fillPct(m) { return m.initialCollateralAmount ? Number((m.funded * 10000n) / m.initialCollateralAmount) / 100 : 0 }
function estimatedApr(m) { return apr(Number(formatUnits(m.targetRaiseUsdc, 6)), Number(formatUnits(m.totalRepaymentUsdc, 6)), Number(m.fundingDeadline), Number(m.repaymentDeadline)) }
function lendRow(m) {
  return `<div class="trow ${m.id === selectedLendId ? 'selected' : ''}"><span class="asset-cell">${tokenIcon(m.logo)}<span><strong>${e(m.token)}</strong><small>${shortAddress(m.collateral)}</small></span></span><span>${e(fmt(m.targetRaiseUsdc, 6, 2))} USDC</span><span>${e(fmt(m.totalRepaymentUsdc, 6, 2))} USDC</span><span>${formatDate(m.fundingDeadline)}</span><span class="green">${estimatedApr(m).toFixed(1)}%</span><span>${e(fmt(m.sale.amountRemaining, m.decimals, 6))} P</span><button data-select-market="${e(m.id)}" class="link-btn">View</button></div>`
}
function lendPreview(m) {
  const fee = m.sale.usdcRemaining ? (m.sale.usdcRemaining * CONFIG.SALE_FEE_BPS) / 10000n : 0n
  return `<h2>Lend into position</h2><div class="asset-large">${tokenIcon(m.logo)}<div><strong>${e(m.token)}</strong><small>${shortAddress(m.collateral)}</small></div></div>${previewRows([['P remaining', `${e(fmt(m.sale.amountRemaining, m.decimals, 6))} P`], ['Initial P', `${e(fmt(m.sale.amountInitial, m.decimals, 6))} P`], ['USDC remaining', `${e(fmt(m.sale.usdcRemaining, 6, 2))} USDC`], ['Target raise', `${e(fmt(m.targetRaiseUsdc, 6, 2))} USDC`], ['Total repayment', `${e(fmt(m.totalRepaymentUsdc, 6, 2))} USDC`], ['Funding deadline', formatDate(m.fundingDeadline)], ['Repayment deadline', formatDate(m.repaymentDeadline)], ['Fill', `${fillPct(m).toFixed(1)}%`], ['Estimated APR', `<span class="green">${estimatedApr(m).toFixed(1)}%</span>`], ['Marketplace fee estimate', `${e(fmt(fee, 6, 4))} USDC`], ['Default outcome', `${e(fmt(m.accountedCollateral, m.decimals, 6))} ${e(m.token)} collateral`], ['Vault', addressLink(m.vault)]])}<div class="two-cols"><label>P amount<div class="unit-input"><input id="pAmount" placeholder="0"></div></label><label>Max USDC budget<div class="unit-input"><input id="budgetUsdc" placeholder="0"><span>USDC</span></div></label></div><div id="budgetQuote" class="hint"></div><button id="fundPosition" class="primary-action" ${isWriteDisabled({ wrongNetwork: account && !isBase(), pending }) || factoryState.purchasesPaused ? 'disabled' : ''}>Fund position</button>`
}
async function updateBudgetQuote(m) {
  if (!m) return
  const budget = parseAmount($('budgetUsdc').value, 6)
  if (!budget) return $('budgetQuote').textContent = ''
  const mp = marketplace(true)
  const best = await pAmountForBudget({ high: m.sale.amountRemaining, budget, quoteTotalPayment: async (p) => (await mp.quoteTotalPayment(m.saleId, p))[2] })
  $('pAmount').value = fmt(best, m.decimals, 8)
  $('budgetQuote').textContent = `Largest P amount within budget: ${fmt(best, m.decimals, 8)} P`
}
async function fundSelected(m) {
  if (!m) return
  if (!account) return setNoticeText('Connect wallet to fund a position.', true)
  if (!isBase()) return setNoticeText('Switch to Base before funding.', true)
  if (factoryState.purchasesPaused) return setNoticeText('New marketplace purchases are paused.', true)
  const pAmount = parseAmount($('pAmount').value, m.decimals)
  const budget = parseAmount($('budgetUsdc').value, 6)
  if (!pAmount || !budget) return setNoticeText('Enter a P amount and maximum USDC budget.', true)
  const mpRead = marketplace(true)
  const sale = saleTuple(await mpRead.sales(m.saleId))
  if (!sale.active || sale.amountRemaining < pAmount || BigInt(nowSec()) >= sale.expiry) return setNoticeText('Sale is no longer available.', true)
  let quote = await mpRead.quoteTotalPayment(m.saleId, pAmount)
  if (quote[2] > budget) return setNoticeText('Latest quote exceeds your approved budget. Review the amount before funding.', true)
  const usdc = erc20(CONFIG.BASE_USDC, false)
  const allowance = await usdc.allowance(account, CONFIG.MARKETPLACE_ADDRESS)
  if (allowance < quote[2]) await sendTx('Approve USDC', async () => usdc.approve(CONFIG.MARKETPLACE_ADDRESS, quote[2]))
  quote = await marketplace(true).quoteTotalPayment(m.saleId, pAmount)
  if (quote[2] > budget) return setNoticeText('Quote changed above your budget after approval. No purchase was sent.', true)
  await sendTx('Fund position', async () => marketplace(false).buy(m.saleId, pAmount, quote[2]))
}

function renderPortfolio() {
  const borrowerRows = account ? markets.filter((m) => m.borrower.toLowerCase() === account.toLowerCase()) : []
  const lenderRows = account ? markets.filter((m) => m.pBalance > 0n) : []
  $('view').innerHTML = `<section class="portfolio"><div class="card table-card"><h2>Your borrow positions</h2>${borrowerRows.length ? portfolioTable(['Collateral', 'Funded', 'USDC received', 'Repayment required', 'Status', 'Action'], borrowerRows.map(borrowerRow)) : '<div class="empty-state">Connect wallet or create a market to track borrower positions here.</div>'}</div><div class="card table-card"><h2>Your lend positions</h2>${lenderRows.length ? portfolioTable(['Collateral', 'P balance', 'Redeem preview', 'Deadline', 'Status', 'Action'], lenderRows.map(lenderRow)) : '<div class="empty-state">Live funded P positions will appear here.</div>'}</div></section>`
  document.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => portfolioAction(b.dataset.action, b.dataset.vault))
}
function statusFor(m) { if (m.settled) return 'Redeemable'; if (m.fundingClosed) return 'Repayment'; if (m.sale?.active) return 'Funding'; return 'Open' }
function borrowerRow(m) {
  const received = (m.targetRaiseUsdc * m.funded) / (m.initialCollateralAmount || 1n)
  return [asset(m), `${fillPct(m).toFixed(1)}%`, `${fmt(received, 6, 2)} USDC`, `${fmt(m.repaymentRequiredUsdc, 6, 2)} USDC`, badge(statusFor(m)), actionButtons(m, 'borrower')]
}
function lenderRow(m) {
  const preview = m.settled ? `${fmt(m.preview.usdcOut, 6, 2)} USDC / ${fmt(m.preview.collateralOut, m.decimals, 6)} ${e(m.token)}` : 'After settlement'
  return [asset(m), `${fmt(m.pBalance, m.decimals, 6)} P`, preview, formatDate(m.repaymentDeadline), badge(statusFor(m)), actionButtons(m, 'lender')]
}
function actionButtons(m, role) {
  const buttons = []
  if (role === 'borrower' && m.sale?.active) buttons.push(['cancel', 'Cancel sale'])
  if (role === 'borrower' && m.sale?.active && BigInt(nowSec()) >= m.sale.expiry) buttons.push(['closeExpired', 'Close expired'])
  if (role === 'borrower' && m.collateralRefundClaim > 0n) buttons.push(['claimRefund', 'Claim refund'])
  if (role === 'borrower' && m.fundingClosed && !m.settled && m.repaymentRemainingUsdc > 0n && BigInt(nowSec()) <= m.repaymentDeadline) buttons.push(['repay', 'Repay in full'])
  if (!m.settled && (m.canSettleEarly || BigInt(nowSec()) > m.repaymentDeadline)) buttons.push(['settle', 'Settle'])
  if (role === 'borrower' && m.pBalance > 0n && m.nBalance >= m.pBalance && m.fundingClosed && !m.settled) buttons.push(['redeemPair', 'Redeem P+N'])
  if (role === 'lender' && m.settled && m.pBalance > 0n) buttons.push(['redeemP', 'Redeem P'])
  if (role === 'lender' && !m.settled && m.pBalance > 0n) buttons.push(['settleRedeem', 'Settle + redeem'])
  return buttons.map(([action, label]) => `<button class="link-btn" data-action="${action}" data-vault="${e(m.vault)}">${label}</button>`).join(' ') || '<span class="hint">No action</span>'
}
async function portfolioAction(action, vaultAddress) {
  const m = markets.find((x) => x.vault === vaultAddress)
  if (!m || !account) return
  if (!isBase()) return setNoticeText('Switch to Base before writing.', true)
  const v = vaultContract(vaultAddress, false)
  if (action === 'cancel') return sendTx('Cancel sale', () => marketplace(false).cancel(m.saleId))
  if (action === 'closeExpired') return sendTx('Close expired sale', () => marketplace(false).closeExpired(m.saleId))
  if (action === 'claimRefund') return sendTx('Claim collateral refund', () => v.claimCollateralRefund(account))
  if (action === 'repay') {
    const usdc = erc20(CONFIG.BASE_USDC, false)
    const needed = await vaultContract(vaultAddress, true).repaymentRemainingUsdc()
    if ((await usdc.allowance(account, vaultAddress)) < needed) await sendTx('Approve repayment USDC', () => usdc.approve(vaultAddress, needed))
    return sendTx('Repay in full', () => v.repayInFull())
  }
  if (action === 'settle') return sendTx('Settle position', () => v.settle())
  if (action === 'redeemPair') return sendTx('Redeem matching P and N', () => v.redeemPair(m.pBalance < m.nBalance ? m.pBalance : m.nBalance))
  if (action === 'redeemP') return sendTx('Redeem P', () => v.redeemP(m.pBalance))
  if (action === 'settleRedeem') return sendTx('Settle and redeem P', () => v.settleAndRedeemP(m.pBalance))
}

function asset(p) { return `<span class="asset-cell">${tokenIcon(p.logo)}<span><strong>${e(p.token)}</strong><small>${shortAddress(p.collateral)}</small></span></span>` }
function badge(statusText) { return `<span class="badge ${e(statusText.toLowerCase())}">${e(statusText)}</span>` }
function portfolioTable(head, rows) { return `<div class="portfolio-table"><div class="portfolio-head">${head.map((h) => `<span>${e(h)}</span>`).join('')}</div>${rows.map((r) => `<div class="portfolio-row">${r.map((c) => `<span>${c}</span>`).join('')}</div>`).join('')}</div>` }
function splitModule(mode) {
  if (mode === 'lend') return `<div class="lend-flow"><div class="lend-step"><strong>USDC</strong><span>Fund with USDC</span><small>Provide USDC to fund the position.</small></div><div class="flow-arrow">→</div><div class="lend-step"><strong>P</strong><span>Receive P claim</span><small>P represents your right to the agreed repayment.</small></div><div class="flow-arrow">→</div><div class="outcome-stack"><div><strong>Borrower repays</strong><small>Receive the agreed USDC repayment.</small></div><div><strong>Borrower does not repay</strong><small>Redeem the locked collateral.</small></div></div></div>`
  const steps = [['Lock your collateral', 'Deposit your token to open the position.'], ['Create P and N', 'Your collateral is split into two linked tokens.'], ['Sell P for USDC', 'Selling P gives you the USDC funding.'], ['Keep N', 'N gives you the right to repay later and reclaim your collateral.']]
  return `<div class="split-module borrower-how"><div class="split-diagram"><div class="split-top">Collateral</div><div class="split-line"></div><div class="split-legs"><div><strong>P</strong><span>Sold for USDC</span><small>Lender claim</small></div><div><strong>N</strong><span>Keep to reclaim</span><small>Borrower right</small></div></div></div><div class="split-copy"><ol>${steps.map(([title, copy]) => `<li><strong>${e(title)}</strong><span>${e(copy)}</span></li>`).join('')}</ol><div class="outcomes"><div><strong>If you repay by the deadline</strong><span>you get your collateral back</span></div><div><strong>If you do not repay</strong><span>the lender can redeem the collateral</span></div></div></div></div>`
}
function previewRows(rows) { return `<div class="preview-rows">${rows.map(([k, v]) => `<div><span>${e(k)}</span><strong>${v}</strong></div>`).join('')}</div>` }

async function boot() {
  app.innerHTML = '<div class="shell"><div class="notice">Loading PMFI V2.2 interface…</div></div>'
  if (window.ethereum) {
    browserProvider = new BrowserProvider(window.ethereum)
    const accounts = await browserProvider.send('eth_accounts', []).catch(() => [])
    chainId = Number((await browserProvider.getNetwork().catch(() => ({ chainId: 0n }))).chainId)
    if (accounts[0]) { signer = await browserProvider.getSigner(); account = await signer.getAddress() }
    setupWalletEvents()
  }
  await refreshAll()
  await render()
}
boot().catch((error) => { app.innerHTML = `<div class="shell"><div class="notice danger"><strong>Could not initialize.</strong> ${sanitizeError(error)}</div></div>` })
