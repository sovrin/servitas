import type { DatabaseSync } from 'node:sqlite'
import {
  parseAppConfiguration,
  type RepositoryInspectionInput,
  type RepositoryConfiguration,
} from '@servitas/contracts/configuration'
import {
  finishJob,
  getRepositoryInspection,
  recordRepositoryResult,
  renewLease,
  reportProgress,
  repositoryCommit,
  type ClaimedJob,
} from '@servitas/core'
import { withGitRepository } from './git'

// Read Git objects directly: repository symlinks and submodules are never followed.
export async function readRepositoryConfiguration(
  git: (...args: string[]) => Promise<string>,
  commit: string,
  request: RepositoryInspectionInput,
): Promise<RepositoryConfiguration> {
  const paths = request.path ? [request.path] : ['servitas.json', 'servitas.yaml', 'servitas.yml']
  const entries = (await git('ls-tree', '-z', commit, '--', ...paths)).split('\0').filter(Boolean)
  if (!entries.length)
    throw new Error(
      'No Servitas configuration found. Enter its path, or configure the app manually.',
    )
  if (entries.length > 1)
    throw new Error('Multiple configuration files found. Enter the path of the file to import.')
  const entry = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entries[0]!)
  if (!entry) throw new Error('Configuration must be a regular file, not a symlink or submodule.')
  const object = entry[2]!
  const path = entry[3]!
  if (Number((await git('cat-file', '-s', object)).trim()) > 65_536)
    throw new Error('Configuration files must be 64 KB or smaller.')
  const configuration = parseAppConfiguration(await git('cat-file', 'blob', object), path)
  if (
    configuration.source &&
    (configuration.source.type !== 'git' || configuration.source.url !== request.source.url)
  )
    throw new Error('Repository configuration must omit source or use the selected Git repository.')
  return {
    configuration: {
      ...configuration,
      source: {
        ...request.source,
        dockerfile: configuration.source?.dockerfile || request.source.dockerfile,
        revision: commit,
      },
    },
    path,
    commit,
  }
}

export async function runRepositoryInspection(db: DatabaseSync, claim: ClaimedJob) {
  const timer = setInterval(() => renewLease(db, claim), 5000)
  let readingConfiguration = false
  try {
    const inspection = getRepositoryInspection(db, claim.job.id)!
    if (!inspection.result) {
      if (!reportProgress(db, claim, 'Fetching the Git revision.')) return
      const result = await withGitRepository(
        inspection.request.source,
        repositoryCommit(db, claim.job.id),
        (commit) => {
          if (!recordRepositoryResult(db, claim, commit)) throw new Error('Worker lease expired.')
        },
        async ({ git, commit }) => {
          if (!reportProgress(db, claim, `Reading configuration at ${commit.slice(0, 12)}.`))
            throw new Error('Worker lease expired.')
          readingConfiguration = true
          return readRepositoryConfiguration(git, commit, inspection.request)
        },
      )
      if (!recordRepositoryResult(db, claim, result.commit, result)) return
    }
    finishJob(db, claim, 'succeeded', 'Configuration is ready to review. No app has been changed.')
  } catch (error) {
    // Git stderr can contain server-controlled data. Configuration errors are bounded data-validation messages.
    const message =
      readingConfiguration && error instanceof Error
        ? error.message.slice(0, 2000)
        : 'Could not fetch the repository. Check the public HTTPS URL and revision, then try again.'
    finishJob(db, claim, 'failed', message)
  } finally {
    clearInterval(timer)
  }
}
