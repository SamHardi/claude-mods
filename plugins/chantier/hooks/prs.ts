// Your open PRs and the Mergify backports of your merged ones, read through gh, sorted by what they wait for.

import type { Config } from './config'
import type { PrChecks, PrGroup, PrItem, SessionRef } from '../types'

export type Run = (argv: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

type GhCheck = { conclusion?: string | null; state?: string | null; status?: string | null }
type GhPr = {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName?: string
  isDraft: boolean
  updatedAt: string
  reviewDecision?: string | null
  mergeable?: string | null
  mergeStateStatus?: string | null
  labels?: { name: string }[]
  statusCheckRollup?: GhCheck[] | null
  body?: string | null
}

const FIELDS = 'number,title,url,headRefName,baseRefName,isDraft,updatedAt,reviewDecision,mergeable,mergeStateStatus,labels,statusCheckRollup,body'
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/g
const BACKPORT_BRANCH = /^mergify\/bp\/([^/]+)\/pr-(\d+)$/
/** Look like ticket keys once upper-cased, but name a PR or a backport (`mergify/bp/4.12.x/pr-21834`). */
const NOT_TICKETS = new Set(['PR', 'BP'])

export function ticketOf(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    for (const m of (text ?? '').toUpperCase().matchAll(TICKET)) {
      const key = m[1] as string
      if (!NOT_TICKETS.has(key.split('-')[0] as string)) return key
    }
  }
  return null
}

export function checksOf(rollup: GhCheck[] | null | undefined): PrChecks {
  const out = { ok: 0, fail: 0, pending: 0 }
  for (const c of rollup ?? []) {
    const verdict = (c.conclusion || c.state || '').toUpperCase()
    const running = !c.conclusion && c.status && c.status.toUpperCase() !== 'COMPLETED'
    if (running || verdict === 'PENDING' || verdict === 'EXPECTED' || verdict === '') out.pending++
    else if (FAIL.has(verdict)) out.fail++
    else out.ok++
  }
  return out
}

export function groupOf(pr: Pick<PrItem, 'isDraft' | 'review' | 'isConflict' | 'checks' | 'updatedAt'>, now: number, staleDays: number): PrGroup {
  if (pr.isDraft) return 'draft'
  // A PR nobody touched for weeks is stale first: its old conflict is not today's emergency.
  if (now - Date.parse(pr.updatedAt) > staleDays * 86_400_000) return 'stale'
  if (pr.isConflict || pr.checks.fail > 0 || pr.review === 'CHANGES_REQUESTED') return 'need'
  if (pr.review === 'APPROVED' && pr.checks.pending === 0) return 'ready'
  return 'review'
}

export function toItem(repo: string, pr: GhPr, now: number, staleDays: number, worktrees: Map<string, string>): PrItem {
  const bp = BACKPORT_BRANCH.exec(pr.headRefName)
  const labels = (pr.labels ?? []).map(l => l.name)
  const base = {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.headRefName,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    review: pr.reviewDecision ?? '',
    isConflict: pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY' || labels.includes('conflicts'),
    checks: checksOf(pr.statusCheckRollup),
    ticket: bp ? ticketOf(pr.body, pr.title) : ticketOf(pr.headRefName, pr.title),
    worktree: worktrees.get(`${repo}:${pr.headRefName}`) ?? null,
    backportOf: bp ? Number(bp[2]) : null,
    base: bp ? (bp[1] as string) : pr.baseRefName ?? null,
    session: null,
  }
  return { ...base, group: groupOf(base, now, staleDays) }
}

async function ghJson<T>(run: Run, args: string[]): Promise<T> {
  const { exitCode, stdout, stderr } = await run(['gh', ...args])
  if (exitCode !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${stderr.trim().slice(0, 200)}`)
  return JSON.parse(stdout || '[]') as T
}

/** `repo:branch` → worktree path for every configured clone, prunable entries left out. */
export async function worktreesOf(run: Run, home: string, clones: Config['clones']): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const [repo, paths] of Object.entries(clones)) {
    for (const path of paths) {
      const dir = path.startsWith('/') ? path : `${home}/${path}`
      const { exitCode, stdout } = await run(['git', '-C', dir, 'worktree', 'list', '--porcelain'])
      if (exitCode !== 0) continue
      for (const block of stdout.split('\n\n')) {
        if (/\nprunable/.test(block)) continue
        const tree = /^worktree (.+)$/m.exec(block)?.[1]
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
        if (tree && branch && !map.has(`${repo}:${branch}`)) map.set(`${repo}:${branch}`, tree)
      }
    }
  }
  return map
}

export async function fetchPrs(run: Run, home: string, now: number, config: Config): Promise<PrItem[]> {
  const scope = config.owner ? ['--owner', config.owner] : []
  const found = await ghJson<{ repository: { nameWithOwner: string } }[]>(run, [
    'search', 'prs', '--author', '@me', '--state', 'open', ...scope, '--json', 'repository', '--limit', '100',
  ])
  const repos = new Set(found.map(f => f.repository.nameWithOwner))
  const worktrees = await worktreesOf(run, home, config.clones)
  const items: PrItem[] = []
  for (const full of repos) {
    const repo = full.split('/')[1] ?? full
    const prs = await ghJson<GhPr[]>(run, ['pr', 'list', '-R', full, '--author', '@me', '--state', 'open', '--json', FIELDS, '--limit', '100'])
    items.push(...prs.map(pr => toItem(repo, pr, now, config.staleDays, worktrees)))
  }
  for (const repo of config.backportRepos) {
    const full = repo.includes('/') ? repo : `${config.owner}/${repo}`
    const name = full.split('/')[1] ?? full
    const merged = await ghJson<{ number: number }[]>(run, ['pr', 'list', '-R', full, '--author', '@me', '--state', 'merged', '--json', 'number', '--limit', '60'])
    const mine = new Set(merged.map(m => m.number))
    const bots = await ghJson<GhPr[]>(run, ['pr', 'list', '-R', full, '--author', 'app/mergify', '--state', 'open', '--json', FIELDS, '--limit', '100'])
    for (const pr of bots) {
      const bp = BACKPORT_BRANCH.exec(pr.headRefName)
      if (bp && mine.has(Number(bp[2]))) items.push(toItem(name, pr, now, config.staleDays, worktrees))
    }
  }
  return items
}

/** What changed between two snapshots that deserves a toast. */
export function changes(before: PrItem[], after: PrItem[]): string[] {
  const prev = new Map(before.map(p => [`${p.repo}#${p.number}`, p]))
  const next = new Map(after.map(p => [`${p.repo}#${p.number}`, p]))
  const out: string[] = []
  for (const [key, p] of next) {
    const was = prev.get(key)
    if (!was) continue
    if (was.checks.pending > 0 && p.checks.pending === 0) {
      out.push(p.checks.fail > 0 ? `CI failed · ${key} (${p.checks.fail} checks)` : `CI green · ${key}`)
    }
    if (was.review !== 'APPROVED' && p.review === 'APPROVED') out.push(`PR approved · ${key}`)
    if (was.review !== 'CHANGES_REQUESTED' && p.review === 'CHANGES_REQUESTED') out.push(`Changes requested · ${key}`)
    if (!was.isConflict && p.isConflict) out.push(`Conflict · ${key}${p.backportOf ? ` (backport to ${p.base})` : ''}`)
  }
  for (const key of prev.keys()) {
    if (!next.has(key)) out.push(`PR closed or merged · ${key}`)
  }
  return out
}

/** A session as the desktop app lists it (mcp__ccd_session_mgmt__list_sessions). */
export type AppSession = { sessionId: string; title?: string; branch?: string; cwd?: string; link?: string; prNumber?: number; isArchived?: boolean }

/** The app's session list, from whatever shape a tool call hands back: a JSON text, content blocks, or the array. */
export function parseSessions(answer: unknown): AppSession[] {
  const texts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.sessionId === 'string') texts.push(JSON.stringify([o]))
      else for (const key of ['text', 'result', 'content']) if (key in o) walk(o[key])
    }
  }
  walk(answer)
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed) && parsed.every(x => x && typeof x === 'object' && 'sessionId' in x)) return parsed as AppSession[]
    } catch {
      // Not the JSON list: a status line or a note, the next block may hold it.
    }
  }
  return []
}

/** The open session working on a PR: its own PR number (or the backported one), then branch, worktree, and a title led by its ticket key. */
export function sessionFor(pr: Pick<PrItem, 'number' | 'backportOf' | 'branch' | 'worktree' | 'ticket'>, sessions: AppSession[]): SessionRef | null {
  const open = sessions.filter(x => !x.isArchived)
  const ticket = pr.ticket ? new RegExp(`^${pr.ticket}\\b`, 'i') : null
  const hit = open.find(x => x.prNumber === pr.number)
    ?? open.find(x => x.branch === pr.branch)
    ?? (pr.backportOf ? open.find(x => x.prNumber === pr.backportOf) : undefined)
    ?? (pr.worktree ? open.find(x => x.cwd === pr.worktree) : undefined)
    ?? (ticket ? open.find(x => ticket.test(x.title ?? '')) : undefined)
  return hit ? { id: hit.sessionId, title: hit.title ?? hit.sessionId, link: hit.link ?? null } : null
}

/** Checks still pending a day after the PR last moved are stuck, not running. */
export function isCiStuck(pr: Pick<PrItem, 'checks' | 'updatedAt'>, now: number): boolean {
  return pr.checks.pending > 0 && now - Date.parse(pr.updatedAt) > 86_400_000
}
