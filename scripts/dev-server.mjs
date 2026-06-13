import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
const root = process.argv[2] || '.'
const port = Number(process.argv[3] || process.env.PORT || 5173)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    let path = normalize(url.pathname).replace(/^\/+/, '') || 'index.html'
    if (!extname(path)) path = 'index.html'
    const body = await readFile(join(root, path))
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
})
server.listen(port, '0.0.0.0', () => console.log(`PMFI dApp dev server http://0.0.0.0:${port}`))
