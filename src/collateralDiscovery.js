export function normalizeAddress(address) { return String(address || '').toLowerCase() }

export function dedupeCollateralEvents(events) {
  const seen = new Set()
  const out = []
  for (const event of events) {
    const address = event?.collateral || event?.args?.collateral || event?.address
    const key = normalizeAddress(address)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(address)
  }
  return out
}

export function withMetadataFallback(address, metadata = {}) {
  const short = address ? `${String(address).slice(0, 6)}…${String(address).slice(-4)}` : 'Unknown token'
  return {
    address,
    symbol: metadata.symbol ? String(metadata.symbol) : 'TOKEN',
    name: metadata.name ? String(metadata.name) : `Token ${short}`,
    decimals: Number.isFinite(Number(metadata.decimals)) ? Number(metadata.decimals) : 18,
    balance: typeof metadata.balance === 'bigint' ? metadata.balance : 0n,
    allowed: Boolean(metadata.allowed),
  }
}

export function searchTokens(tokens, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return tokens
  return tokens.filter((token) => [token.symbol, token.name, token.address].some((value) => String(value || '').toLowerCase().includes(q)))
}

export function sortTokensByWalletBalance(tokens) {
  return [...tokens].sort((a, b) => {
    const aOwned = a.balance > 0n ? 1 : 0
    const bOwned = b.balance > 0n ? 1 : 0
    if (aOwned !== bOwned) return bOwned - aOwned
    if (a.balance !== b.balance) return a.balance > b.balance ? -1 : 1
    return String(a.symbol || '').localeCompare(String(b.symbol || ''))
  })
}

async function getLogsWithRetry({ fromBlock, toBlock, minRange = 256n, getLogs }) {
  try { return await getLogs(fromBlock, toBlock) } catch (error) {
    if (toBlock <= fromBlock || (toBlock - fromBlock) <= minRange) throw error
    const mid = fromBlock + ((toBlock - fromBlock) / 2n)
    const left = await getLogsWithRetry({ fromBlock, toBlock: mid, minRange, getLogs })
    const right = await getLogsWithRetry({ fromBlock: mid + 1n, toBlock, minRange, getLogs })
    return [...left, ...right]
  }
}

export async function discoverCollateralTokens({ fromBlock, toBlock, rangeSize = 50000n, getLogs, parseLog, isAllowed, readMetadata }) {
  const logs = []
  let start = BigInt(fromBlock)
  const end = BigInt(toBlock)
  while (start <= end) {
    const stop = start + rangeSize - 1n > end ? end : start + rangeSize - 1n
    logs.push(...await getLogsWithRetry({ fromBlock: start, toBlock: stop, getLogs }))
    start = stop + 1n
  }
  const addresses = dedupeCollateralEvents(logs.map(parseLog))
  const tokens = []
  for (const address of addresses) {
    if (!await isAllowed(address)) continue
    tokens.push(withMetadataFallback(address, { ...await readMetadata(address).catch(() => ({})), allowed: true }))
  }
  return sortTokensByWalletBalance(tokens)
}
