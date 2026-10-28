export type PrGroup = 'need' | 'ready' | 'review' | 'draft' | 'stale'

export type PrChecks = { ok: number; fail: number; pending: number }

export type PrItem = {
  repo: string
  number: number
  title: string
  url: string
  branch: string
  isDraft: boolean
  updatedAt: string
  review: string
  isConflict: boolean
  checks: PrChecks
  ticket: string | null
  group: PrGroup
  worktree: string | null
  backportOf: number | null
  base: string | null
  /** The open session working on this PR (same PR number, branch, worktree or ticket). */
  session: SessionRef | null
}

export type SessionRef = { id: string; title: string; link: string | null }

export type PrSnapshot = { at: number; items: PrItem[]; error: string | null }

export type View = 'pr' | 'plan' | 'run' | 'land'

/** Which PRs the PR view lists, by what they wait for. */
export type PrFilter = 'all' | 'act' | 'review' | 'draft' | 'stale'

export type Executor = 'session' | 'workflow' | 'agent' | 'you'

export type BriqueStatus = 'todo' | 'running' | 'waiting' | 'blocked' | 'done'

export type Brique = {
  id: string
  title: string
  repo: string
  lane: string
  wave: number
  executor: Executor
  status: BriqueStatus
  ticket?: string
  dependsOn?: string[]
  branch?: string
  worktree?: string
  pr?: { repo: string; number: number }
  note?: string
  question?: string
}

export type Plan = { epic: string; title: string; updatedAt: string; briques: Brique[] }

export type Here = { toplevel: string | null; branch: string | null; ticket: string | null }

declare module 'claude-code' {
  interface PluginState {
    chantier: {
      prs: PrSnapshot | null
      view: View
      plan: Plan | null
      here: Here | null
      filter: PrFilter
      /** The repo the PR view is narrowed to; empty for every repo. */
      repo: string
    }
  }
}
