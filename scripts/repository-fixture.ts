import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:https'

// An isolated HTTPS Git remote, with a test-only CA trusted explicitly by the test worker.
// Nothing is published and TLS verification stays enabled.
export async function repositoryFixture() {
  mkdirSync('.context', { recursive: true })
  const dir = mkdtempSync(resolve('.context/repository-fixture-'))
  const repo = join(dir, 'app.git')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '--quiet', '--initial-branch=main')
  mkdirSync(join(repo, 'examples/hello-cloud'), { recursive: true })
  copyFileSync('examples/hello-cloud/server.ts', join(repo, 'examples/hello-cloud/server.ts'))
  copyFileSync('examples/hello-cloud/Dockerfile', join(repo, 'Dockerfile'))
  writeFileSync(
    join(repo, 'servitas.yaml'),
    'version: 1\nname: git-demo\nport: 3000\nhealthCheck: /health\naccess: public\n',
  )
  mkdirSync(join(repo, 'alternate'))
  writeFileSync(
    join(repo, 'alternate/servitas.json'),
    '{"version":1,"name":"git-demo","port":3000,"access":"private"}',
  )
  git('add', '.')
  git(
    '-c',
    'user.name=Servitas test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'Repository fixture',
  )
  const commit = git('rev-parse', 'HEAD').trim()
  const cert = join(dir, 'certificate.pem')
  const key = join(dir, 'key.pem')
  const config = join(dir, 'openssl.cnf')
  writeFileSync(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Servitas test Git\n[v3]\nsubjectAltName=DNS:host.docker.internal,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n',
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      config,
    ],
    { stdio: 'ignore' },
  )
  let fetches = 0
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      const url = new URL(request.url!, 'https://127.0.0.1')
      if (url.pathname.endsWith('/git-upload-pack')) fetches++
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: dir,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers['content-type'],
          REMOTE_ADDR: '127.0.0.1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      request.pipe(child.stdin)
      child.stdin.on('error', () => {})
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.resume()
      child.on('error', () => {
        response.writeHead(500)
        response.end()
      })
      child.on('close', () => {
        if (response.writableEnded) return
        const output = Buffer.concat(chunks)
        const split = output.indexOf('\r\n\r\n')
        if (split < 0) {
          response.writeHead(500)
          response.end()
          return
        }
        for (const line of output.subarray(0, split).toString().split('\r\n')) {
          const index = line.indexOf(':')
          const name = line.slice(0, index)
          const value = line.slice(index + 1).trim()
          if (name.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0])
          else response.setHeader(name, value)
        }
        response.end(output.subarray(split + 4))
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = (server.address() as { port: number }).port
  const override = join(dir, 'compose.yaml')
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        worker: {
          environment: { GIT_SSL_CAINFO: '/test-git-ca.pem' },
          volumes: [{ type: 'bind', source: cert, target: '/test-git-ca.pem', read_only: true }],
          extra_hosts: ['host.docker.internal:host-gateway'],
        },
      },
    }),
  )
  return {
    url: `https://host.docker.internal:${port}/app.git`,
    commit,
    override,
    get fetches() {
      return fetches
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
