import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const run = promisify(execFile)
export async function withGitRepository<T>(
  source: { url: string; revision: string },
  pinnedCommit: string | null,
  recordCommit: (commit: string) => void,
  action: (repository: {
    dir: string
    commit: string
    git: (...args: string[]) => Promise<string>
  }) => Promise<T>,
) {
  const dir = await mkdtemp(resolve(tmpdir(), 'servitas-git-'))
  const git = async (...args: string[]) =>
    (
      await run(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-C',
          dir,
          ...args,
        ],
        {
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        },
      )
    ).stdout
  try {
    await git('init', '--quiet')
    await git('remote', 'add', 'origin', source.url)
    await git('fetch', '--depth=1', 'origin', pinnedCommit || source.revision)
    const commit = (await git('rev-parse', 'FETCH_HEAD')).trim()
    recordCommit(commit)
    return await action({ dir, commit, git })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
