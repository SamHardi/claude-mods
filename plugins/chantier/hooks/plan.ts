// The chantier plan: the briques Claude proposes, validated, saved outside the repos, and the orders derived from it.

import type { Brique, BriqueStatus, Executor, Plan } from '../types'

const EXECUTORS: readonly Executor[] = ['session', 'workflow', 'agent', 'you']
const STATUSES: readonly BriqueStatus[] = ['todo', 'running', 'waiting', 'blocked', 'done']
const EPIC = /^[A-Z][A-Z0-9]+-\d+$/

/** The lane of the decisions the person takes. */
export const YOU_LANE = 'You'

export const BRIQUE_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'repo', 'lane', 'wave', 'executor'],
  properties: {
    id: { type: 'string', description: 'Short id, B1, B2… for work, D1… for a decision the person takes.' },
    title: { type: 'string' },
    repo: { type: 'string', description: 'GitHub repo name, e.g. acme-ui.' },
    lane: { type: 'string', description: 'Column of the board: the repo, or the part of a repo that moves separately (backend vs console). "You" for decisions.' },
    wave: { type: 'integer', minimum: 0, description: 'Briques of one wave run in parallel. 0 = already done.' },
    executor: { enum: EXECUTORS, description: 'session: own linked session in its own worktree; workflow: repeated change fanned out; agent: short subagent inside a session; you: the person decides or acts.' },
    status: { enum: STATUSES },
    ticket: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    pr: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] },
    note: { type: 'string', description: 'One line: what the brique does now or why it waits.' },
    question: { type: 'string', description: 'Set while status is waiting: the question the person must answer.' },
  },
} as const

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['epic', 'title', 'briques'],
  properties: {
    epic: { type: 'string', description: 'Ticket key of the epic, e.g. PROJ-157.' },
    title: { type: 'string' },
    briques: { type: 'array', items: BRIQUE_SCHEMA },
  },
} as const

export const UPDATE_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    epic: { type: 'string', description: 'Defaults to the active chantier.' },
    id: { type: 'string' },
    status: { enum: STATUSES },
    note: { type: 'string' },
    question: { type: 'string', description: 'Empty string clears it.' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    pr: BRIQUE_SCHEMA.properties.pr,
    wave: { type: 'integer', minimum: 0 },
    executor: { enum: EXECUTORS },
  },
} as const

export const planPath = (home: string, dir: string, epic: string) => `${home}/${dir}/${epic}.json`

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function toBrique(raw: Record<string, unknown>, errors: string[]): Brique | null {
  const id = str(raw.id)
  const title = str(raw.title)
  const repo = str(raw.repo)
  const lane = str(raw.lane) ?? repo
  const wave = typeof raw.wave === 'number' && Number.isInteger(raw.wave) && raw.wave >= 0 ? raw.wave : null
  const executor = EXECUTORS.find(x => x === raw.executor)
  if (!id || !title || !repo || !lane || wave === null || !executor) {
    errors.push(`brique ${id ?? '?'}: id, title, repo, lane, wave (integer ≥ 0) and executor are required`)
    return null
  }
  const status = STATUSES.find(x => x === raw.status) ?? (wave === 0 ? 'done' : 'todo')
  const pr = raw.pr as { repo?: unknown; number?: unknown } | undefined
  return {
    id, title, repo, lane, wave, executor, status,
    ...(str(raw.ticket) ? { ticket: str(raw.ticket) } : {}),
    ...(Array.isArray(raw.dependsOn) ? { dependsOn: raw.dependsOn.filter((d): d is string => typeof d === 'string') } : {}),
    ...(str(raw.branch) ? { branch: str(raw.branch) } : {}),
    ...(str(raw.worktree) ? { worktree: str(raw.worktree) } : {}),
    ...(pr && typeof pr.repo === 'string' && typeof pr.number === 'number' ? { pr: { repo: pr.repo, number: pr.number } } : {}),
    ...(str(raw.note) ? { note: str(raw.note) } : {}),
    ...(str(raw.question) ? { question: str(raw.question) } : {}),
  }
}

/** Validates what the model sent: the plan, or every reason it is refused. */
export function validatePlan(input: Record<string, unknown>, now: string): { plan: Plan } | { errors: string[] } {
  const errors: string[] = []
  const epic = str(input.epic)?.toUpperCase()
  if (!epic || !EPIC.test(epic)) errors.push('epic: a ticket key, e.g. PROJ-157')
  const title = str(input.title)
  if (!title) errors.push('title is required')
  const raws = Array.isArray(input.briques) ? (input.briques as Record<string, unknown>[]) : []
  if (raws.length === 0) errors.push('briques: at least one')
  const briques = raws.map(r => toBrique(r, errors)).filter((b): b is Brique => b !== null)
  const ids = new Set<string>()
  for (const b of briques) {
    if (ids.has(b.id)) errors.push(`duplicate id: ${b.id}`)
    ids.add(b.id)
  }
  for (const b of briques) {
    for (const d of b.dependsOn ?? []) if (!ids.has(d)) errors.push(`${b.id} depends on ${d}, which does not exist`)
  }
  if (errors.length || !epic || !title) return { errors }
  const cycle = findCycle(briques)
  if (cycle) return { errors: [`circular dependencies: ${cycle.join(' → ')}`] }
  return { plan: { epic, title, updatedAt: now, briques } }
}

export function applyUpdate(plan: Plan, input: Record<string, unknown>, now: string): { plan: Plan } | { error: string } {
  const id = str(input.id)
  const at = plan.briques.findIndex(b => b.id === id)
  if (!id || at === -1) return { error: `brique ${id ?? '?'} is not in chantier ${plan.epic}` }
  const cur = plan.briques[at] as Brique
  const next: Brique = { ...cur }
  const status = STATUSES.find(x => x === input.status)
  if (status) next.status = status
  const executor = EXECUTORS.find(x => x === input.executor)
  if (executor) next.executor = executor
  if (typeof input.wave === 'number' && Number.isInteger(input.wave) && input.wave >= 0) next.wave = input.wave
  for (const key of ['note', 'branch', 'worktree'] as const) {
    const v = str(input[key])
    if (v) next[key] = v
  }
  if (typeof input.question === 'string') {
    if (input.question.trim()) next.question = input.question.trim()
    else delete next.question
  }
  const pr = input.pr as { repo?: unknown; number?: unknown } | undefined
  if (pr && typeof pr.repo === 'string' && typeof pr.number === 'number') next.pr = { repo: pr.repo, number: pr.number }
  if (next.status !== 'waiting') delete next.question
  const briques = plan.briques.slice()
  briques[at] = next
  return { plan: { ...plan, briques, updatedAt: now } }
}

function findCycle(briques: Brique[]): string[] | null {
  const deps = new Map(briques.map(b => [b.id, b.dependsOn ?? []]))
  const state = new Map<string, 'open' | 'closed'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'closed') return null
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'open')
    path.push(id)
    for (const d of deps.get(id) ?? []) {
      const found = visit(d)
      if (found) return found
    }
    path.pop()
    state.set(id, 'closed')
    return null
  }
  for (const b of briques) {
    const found = visit(b.id)
    if (found) return found
  }
  return null
}

export const isDone = (b: Brique) => b.status === 'done'

/** A brique whose dependencies are not all done. */
export function waitsOn(plan: Plan, b: Brique): string[] {
  const byId = new Map(plan.briques.map(x => [x.id, x]))
  return (b.dependsOn ?? []).filter(d => !isDone(byId.get(d) as Brique))
}

/** The briques a given one unblocks. */
export function unblocks(plan: Plan, id: string): string[] {
  return plan.briques.filter(b => (b.dependsOn ?? []).includes(id)).map(b => b.id)
}

/** The first wave that still holds unfinished work. */
export function currentWave(plan: Plan): number | null {
  const open = plan.briques.filter(b => !isDone(b)).map(b => b.wave)
  return open.length ? Math.min(...open) : null
}

/** Landing order: dependencies first, then by wave and id. */
export function mergeOrder(plan: Plan): Brique[] {
  const work = plan.briques.filter(b => b.executor !== 'you')
  const remaining = new Map(work.map(b => [b.id, new Set((b.dependsOn ?? []).filter(d => work.some(w => w.id === d)))]))
  const out: Brique[] = []
  while (remaining.size) {
    const ready = work
      .filter(b => remaining.has(b.id) && (remaining.get(b.id) as Set<string>).size === 0)
      .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id, undefined, { numeric: true }))
    if (!ready.length) break
    for (const b of ready) {
      out.push(b)
      remaining.delete(b.id)
      for (const deps of remaining.values()) deps.delete(b.id)
    }
  }
  return out
}

export function lanes(plan: Plan): string[] {
  const seen: string[] = []
  for (const b of plan.briques) if (!seen.includes(b.lane)) seen.push(b.lane)
  return seen.sort((a, b) => (a === YOU_LANE ? -1 : b === YOU_LANE ? 1 : 0))
}
