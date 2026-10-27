// The rules' parameters. What is specific to one person or org comes from the manifest's userConfig.

import type { PluginOptions } from 'claude-code'

/** A PR base that is a feature branch: merging the PR would land it there, not in the real target. */
export const FEATURE_BASE = /^(feat|fix|chore|refactor|docs|test|ci|perf|style|bp|mergify|claude)\/|[A-Z][A-Z0-9]+-\d+/

/** Session heartbeats, relative to $HOME: outside every repo. */
export const SESSIONS_DIR = '.claude/chantiers/sessions'
export const HEARTBEAT_MS = 60_000
export const SESSION_LIVE_MS = 180_000

/** git by absolute path: a desktop app does not give a mod the shell's PATH. */
export const GIT_BINS = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'] as const

export type Rules = {
  protectedBranches: string[]
  composeEnv: { dir: string; variable: string } | null
}

export function rulesOf(options: PluginOptions): Rules {
  const branches = String(options.protectedBranches ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const [dir, variable] = String(options.composeEnv ?? '').split(':').map(s => s.trim())
  return {
    protectedBranches: branches.length ? branches : ['main', 'master', 'develop'],
    composeEnv: dir && variable ? { dir, variable } : null,
  }
}
