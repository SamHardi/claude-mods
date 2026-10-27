// The mod's settings, read from the manifest's userConfig: everything specific to one person's org and machine lives there.

import type { PluginOptions } from 'claude-code'

export type Config = {
  /** GitHub org or user the PR search is limited to; empty searches every repo. */
  owner: string
  /** Prefix a ticket key is appended to, e.g. https://example.atlassian.net/browse/; empty shows keys without links. */
  ticketUrl: string
  /** Repo name → local clone paths (absolute, or relative to $HOME), scanned for the worktree of a PR's branch. */
  clones: Record<string, string[]>
  /** Repos whose Mergify backports of your merged PRs are tracked. */
  backportRepos: string[]
  staleDays: number
  /** Where plans live, relative to $HOME: outside every repo. */
  planDir: string
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown) => text(v).split(',').map(s => s.trim()).filter(Boolean)

/** `repo=path|path, repo=path` → map. */
export function parseClones(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const entry of list(v)) {
    const [repo, paths] = entry.split('=')
    if (repo && paths) out[repo.trim()] = paths.split('|').map(p => p.trim()).filter(Boolean)
  }
  return out
}

export function configOf(options: PluginOptions): Config {
  const stale = Number(options.staleDays)
  return {
    owner: text(options.owner),
    ticketUrl: text(options.ticketUrl),
    clones: parseClones(options.clones),
    backportRepos: list(options.backportRepos),
    staleDays: Number.isFinite(stale) && stale > 0 ? stale : 30,
    planDir: text(options.planDir) || '.claude/chantiers',
  }
}

export const PR_TTL_MS = 120_000
export const PR_POLL_MS = 150_000
export const HERE_POLL_MS = 60_000
export const MAX_TOASTS_PER_REFRESH = 3

/** Executables by absolute path: a desktop app does not give a mod the shell's PATH. */
export const BIN: Record<string, readonly string[]> = {
  gh: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'],
  git: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'],
}
