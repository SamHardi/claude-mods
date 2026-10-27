// What each PR asks of you today: its pills, the one to take next, and the prompt that hands the job to the right session.

import type { PrFilter, PrGroup, PrItem } from '../types'
import type { Pill } from './pills'
import { isCiStuck } from './prs'

const DAY = 86_400_000

export const FILTERS: { id: PrFilter; label: string; of: PrGroup[] }[] = [
  { id: 'all', label: 'All', of: ['need', 'ready', 'review', 'draft', 'stale'] },
  { id: 'act', label: 'Needs you', of: ['need', 'ready'] },
  { id: 'review', label: 'In review', of: ['review'] },
  { id: 'draft', label: 'Drafts', of: ['draft'] },
  { id: 'stale', label: 'Stale', of: ['stale'] },
]

export function prPills(pr: PrItem, now: number): Pill[] {
  const out: Pill[] = []
  const { ok, fail, pending } = pr.checks
  const total = ok + fail + pending
  if (pr.group === 'ready') out.push({ text: 'Ready to merge', tone: 'green', glyph: 'check' })
  if (pr.isConflict) out.push({ text: 'Conflict', tone: 'red', glyph: 'cross' })
  if (fail) out.push({ text: `${fail} check${fail > 1 ? 's' : ''} failed`, tone: 'red', glyph: 'cross' })
  if (pr.review === 'CHANGES_REQUESTED') out.push({ text: 'Changes requested', tone: 'red', glyph: 'dot' })
  if (pr.review === 'APPROVED' && pr.group !== 'ready') out.push({ text: 'Approved', tone: 'green', glyph: 'check' })
  if (pr.review === 'REVIEW_REQUIRED' && !pr.isDraft) out.push({ text: 'Review required', tone: 'grey', glyph: 'dot' })
  if (pending && isCiStuck(pr, now)) out.push({ text: `CI stuck ${ok}/${total}`, tone: 'amber', glyph: 'clock' })
  else if (pending) out.push({ text: `CI ${ok}/${total}`, tone: 'blue', glyph: 'ring', progress: ok / total })
  else if (total && !fail) out.push({ text: 'CI passed', tone: 'green', glyph: 'check' })
  if (pr.backportOf) out.push({ text: pr.base ?? 'backport', tone: 'purple', glyph: 'arrow' })
  return out
}

/** How urgent a PR is, lowest first; null when it waits on someone else. */
function urgency(pr: PrItem, now: number): number | null {
  if (pr.group === 'draft' || pr.group === 'stale') return null
  if (pr.isConflict) return 0
  if (pr.checks.fail) return 1
  if (pr.review === 'CHANGES_REQUESTED') return 2
  if (pr.group === 'ready') return 3
  if (isCiStuck(pr, now)) return 4
  return null
}

/** The PR to take next: the most urgent, and among equals the one waiting longest. */
export function nextUp(items: readonly PrItem[], now: number): PrItem | null {
  let best: { pr: PrItem; rank: number } | null = null
  for (const pr of items) {
    const rank = urgency(pr, now)
    if (rank === null) continue
    if (!best || rank < best.rank || (rank === best.rank && Date.parse(pr.updatedAt) < Date.parse(best.pr.updatedAt))) best = { pr, rank }
  }
  return best?.pr ?? null
}

/** Why the PR is up next, in one line. */
export function whyOf(pr: PrItem, now: number): string {
  const { ok, fail, pending } = pr.checks
  if (pr.isConflict) return pr.backportOf ? `The backport to ${pr.base} conflicts.` : `Conflicts with ${pr.base ?? 'its base'}.`
  if (fail) return `${fail} of ${ok + fail + pending} checks failed.`
  if (pr.review === 'CHANGES_REQUESTED') return 'A reviewer asked for changes.'
  if (pr.group === 'ready') return 'Approved, every check green.'
  if (isCiStuck(pr, now)) return `Checks pending for ${Math.floor((now - Date.parse(pr.updatedAt)) / DAY)} days.`
  return ''
}

export type Action = { label: string; task: string }

/** The job the PR's state calls for, worded for whichever session does it; null when nothing waits on you. */
export function actionOf(pr: PrItem, now: number): Action | null {
  if (pr.isConflict && pr.backportOf) {
    return { label: 'Fix the backport', task: `Resolve the conflicts of the Mergify backport ${pr.url} (#${pr.backportOf} to ${pr.base}). Push nothing without my go-ahead.` }
  }
  if (pr.isConflict) {
    return { label: 'Resolve conflicts', task: `Rebase ${pr.branch} onto ${pr.base ?? 'its base'} and resolve the conflicts of ${pr.url}. Push nothing without my go-ahead.` }
  }
  if (pr.checks.fail) {
    return { label: 'Triage CI', task: `Find out why the CI of ${pr.url} fails (${pr.checks.fail} checks): read the failing jobs' logs, then propose a fix. Rerun nothing without asking me.` }
  }
  if (pr.review === 'CHANGES_REQUESTED') {
    return { label: 'Address review', task: `Go through the review comments on ${pr.url}: summarise each thread, then propose the fixes. Reply to nothing without my go-ahead.` }
  }
  if (pr.group === 'ready') {
    return { label: 'Merge…', task: `Check that ${pr.url} is still approved with green checks, then ask me before squash-merging it.` }
  }
  if (isCiStuck(pr, now)) {
    return { label: 'Check CI', task: `The checks of ${pr.url} have been pending for over a day: find the stuck job and what it waits for. Rerun nothing without asking me.` }
  }
  return null
}

/** The prompt that hands a job to the session working on the PR, or starts one where the PR's branch lives. */
export function routed(pr: PrItem, task: string): string {
  if (pr.session) return `Send this to session ${pr.session.id} ("${pr.session.title}"), which works on ${pr.url}, and do not do it here:\n${task}`
  if (pr.worktree) return `Start a session in ${pr.worktree} (branch ${pr.branch}) for this:\n${task}`
  return `Start a session in a new worktree on branch ${pr.branch} for this:\n${task}`
}

/** PRs a filter and a repo keep, the most urgent first. */
export function shown(items: readonly PrItem[], filter: PrFilter, repo: string, now: number): PrItem[] {
  const of = FILTERS.find(f => f.id === filter)?.of ?? []
  const rank = (p: PrItem) => urgency(p, now) ?? 9
  return items
    .filter(p => of.includes(p.group) && (repo === '' || p.repo === repo))
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}
