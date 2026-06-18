export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
}
export function sanitizeError(error) {
  return escapeHtml(error?.shortMessage || error?.reason || error?.message || String(error || 'Unknown error')).slice(0, 320)
}
export function shortAddress(a) { return a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—' }
export function formatDate(timestamp) { return new Date(Number(timestamp) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
export function money(n) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) }
export function utf8Bytes(value) { return new TextEncoder().encode(String(value ?? '')).length }
