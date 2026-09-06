import { request } from 'node:http'

// The worker uses only the Unix socket; the web process never receives it.
export function dockerVersion(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/version', method: 'GET', timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 65536) req.destroy(new Error('Unexpected Docker response.'))
      })
      res.on('error', reject)
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Docker did not accept the connection.')
          const data = JSON.parse(body) as { Version?: unknown }
          if (typeof data.Version !== 'string' || !/^[\w.+-]{1,80}$/.test(data.Version))
            throw new Error('Unexpected Docker version response.')
          resolve(data.Version)
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Docker connection timed out.')))
    req.on('error', reject)
    req.end()
  })
}
