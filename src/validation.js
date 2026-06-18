import { CONFIG } from './config.js'
import { utf8Bytes } from './format.js'

export const LIMITS = Object.freeze({ MIN_FUNDING_SECONDS: 3600, MAX_FUNDING_SECONDS: 30 * 86400, MAX_REPAYMENT_SECONDS: 365 * 86400, MAX_PREFIX_BYTES: 32 })

export function validatePrefix(value) {
  const bytes = utf8Bytes(value)
  return bytes > 0 && bytes <= LIMITS.MAX_PREFIX_BYTES
}

export function canCreateWithAllowlist({ allowed, isUsdc, creationPaused, wrongNetwork }) {
  return Boolean(allowed) && !isUsdc && !creationPaused && !wrongNetwork
}

export function validateBorrowForm({ connected, wrongNetwork, creationPaused, collateralAllowed, collateralIsUsdc, collateralAmount, targetRaise, totalRepayment, fundingSeconds, repaymentSeconds, namePrefix, symbolPrefix, decimals, balance, ethBalance }) {
  const errors = []
  if (!connected) errors.push('Connect wallet')
  if (wrongNetwork) errors.push('Switch to Base')
  if (creationPaused) errors.push('Position creation is paused')
  if (!collateralAllowed) errors.push('Collateral is not enabled by the onchain factory allowlist')
  if (collateralIsUsdc) errors.push('Collateral cannot be USDC')
  if (decimals > 30) errors.push('Collateral decimals exceed V2.2 limit')
  if (collateralAmount <= 0n) errors.push('Collateral amount must be greater than zero')
  if (targetRaise <= 0n) errors.push('Target USDC raise must be greater than zero')
  if (totalRepayment <= targetRaise) errors.push('Total repayment must be greater than target raise')
  if (fundingSeconds < LIMITS.MIN_FUNDING_SECONDS || fundingSeconds > LIMITS.MAX_FUNDING_SECONDS) errors.push('Funding window must be between 1 hour and 30 days')
  if (repaymentSeconds <= 0 || repaymentSeconds > LIMITS.MAX_REPAYMENT_SECONDS) errors.push('Repayment window must be between 1 day and 365 days')
  if (!validatePrefix(namePrefix)) errors.push('Name prefix must be 1–32 UTF-8 bytes')
  if (!validatePrefix(symbolPrefix)) errors.push('Symbol prefix must be 1–32 UTF-8 bytes')
  if (balance < collateralAmount) errors.push('Insufficient collateral balance')
  if (ethBalance < CONFIG.CREATION_FEE_WEI) errors.push('Insufficient ETH for creation fee plus gas')
  return errors
}

export function isWriteDisabled({ wrongNetwork, pending }) { return Boolean(wrongNetwork || pending) }
