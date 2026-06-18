import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export function resolveRequestPath(rootDir, pathname) {
  const root = resolve(rootDir)
  let decoded = decodeURIComponent(pathname || '/')
  if (decoded.endsWith('/')) decoded += 'index.html'
  if (!extname(decoded)) decoded = '/index.html'
  const requested = resolve(root, `.${decoded}`)
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return null
  return requested
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }
export function createServer(rootDir = '.', port = 5173) {
  const root = resolve(rootDir)
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const filePath = resolveRequestPath(root, url.pathname)
    if (!filePath) { res.writeHead(403); res.end('Forbidden'); return }
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] || '.')
  const port = Number(process.argv[3] || process.env.PORT || 5173)
  const server = createServer(root, port)
  server.listen(port, '0.0.0.0', () => console.log(`PMFI dApp dev server http://0.0.0.0:${port}`))
}
