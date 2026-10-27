import { atom, read, update } from 'claude-code'
import type { BoxProps, ButtonProps, ElementConstructor, EngineInterface, LinkProps, Register, TextProps, ThemeKey } from 'claude-code'

import type { Brique, BriqueStatus, Here, Plan, PrGroup, PrItem, PrSnapshot, View } from '../types'
import { BIN, HERE_POLL_MS, MAX_TOASTS_PER_REFRESH, PR_POLL_MS, PR_TTL_MS, configOf } from './config'
import type { Config } from './config'
import { changes, fetchPrs, ticketOf } from './prs'
import type { Run } from './prs'
import {
  PLAN_SCHEMA, UPDATE_SCHEMA, YOU_LANE, applyUpdate, currentWave, isDone, lanes, mergeOrder, planPath, unblocks, validatePlan, waitsOn,
} from './plan'

type $ = EngineInterface
type UI = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Link: ElementConstructor<LinkProps>
}

const PANE = 'chantier'
const TITLE = 'Chantier'
const EPIC = /^[A-Z][A-Z0-9]+-\d+$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const prsA = atom({ plugin: 'chantier', key: 'prs' } as const, null)
const viewA = atom({ plugin: 'chantier', key: 'view' } as const, 'pr')
const planA = atom({ plugin: 'chantier', key: 'plan' } as const, null)
const hereA = atom({ plugin: 'chantier', key: 'here' } as const, null)

/* ---------- host access ---------- */

let home: string | null = null
const exe = new Map<string, string>()

async function homeOf($: $): Promise<string> {
  if (!home) home = (await $.env.get('HOME')) ?? ''
  return home
}

async function binOf($: $, name: string): Promise<string> {
  const known = exe.get(name)
  if (known) return known
  for (const path of BIN[name] ?? []) {
    if (await $.fs.exists(path)) {
      exe.set(name, path)
      return path
    }
  }
  return name
}

function runner($: $): Run {
  return async (argv, cwd) => {
    const [name, ...rest] = argv
    try {
      return await $.process.run([await binOf($, name ?? ''), ...rest], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 })
    } catch (err) {
      return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
}

async function git($: $, dir: string, ...args: string[]): Promise<string | null> {
  const { exitCode, stdout } = await runner($)(['git', '-C', dir, ...args])
  return exitCode === 0 ? stdout.trim() : null
}

/* ---------- PR snapshot, shared by every session through the store ---------- */

async function refreshPrs($: $, config: Config, force = false): Promise<PrSnapshot | null> {
  const now = await $.clock.now()
  const cached = (await $.store.get('prs')) as PrSnapshot | undefined
  const lock = (await $.store.get('prsLock')) as number | undefined
  const isFresh = cached !== undefined && now - cached.at < PR_TTL_MS
  if ((isFresh && !force) || (lock !== undefined && now - lock < 90_000)) {
    if (cached) await update($, prsA, () => cached)
    return cached ?? null
  }
  await $.store.set('prsLock', now)
  try {
    const items = await fetchPrs(runner($), await homeOf($), now, config)
    const snapshot: PrSnapshot = { at: now, items, error: null }
    if (cached?.items.length) await announce($, cached.items, items)
    await $.store.set('prs', snapshot)
    await update($, prsA, () => snapshot)
    return snapshot
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    $.ui.log(`chantier: PR refresh failed: ${message}`, { to: 'debug' })
    const failed: PrSnapshot = { at: cached?.at ?? 0, items: cached?.items ?? [], error: message }
    await update($, prsA, () => failed)
    return failed
  } finally {
    await $.store.delete('prsLock')
  }
}

/** Toasts for what moved, and relays for the briques a closed PR unblocks. Only the session that fetched raises them. */
async function announce($: $, before: PrItem[], after: PrItem[]): Promise<void> {
  const lines = changes(before, after)
  const plan = await read($, planA)
  if (plan) {
    const open = new Set(after.map(p => `${p.repo}#${p.number}`))
    for (const b of plan.briques) {
      const pr = b.pr
      if (!pr || open.has(`${pr.repo}#${pr.number}`) || !before.some(p => p.repo === pr.repo && p.number === pr.number)) continue
      const next = unblocks(plan, b.id)
      if (next.length) lines.unshift(`${b.id} closed or merged: unblocks ${next.join(', ')}. /chantier go starts them.`)
    }
  }
  for (const line of lines.slice(0, MAX_TOASTS_PER_REFRESH)) $.ui.toast(line, { timeoutMs: 12_000 })
}

/* ---------- plan file ---------- */

async function activeEpic($: $): Promise<string | null> {
  const epic = await $.store.get('activeEpic')
  return typeof epic === 'string' ? epic : null
}

async function loadPlan($: $, config: Config, epic?: string): Promise<Plan | null> {
  const key = epic ?? (await activeEpic($))
  const path = key ? planPath(await homeOf($), config.planDir, key) : null
  if (!path || !(await $.fs.exists(path))) {
    if (!epic) await update($, planA, () => null)
    return null
  }
  try {
    const plan = JSON.parse(await $.fs.read(path)) as Plan
    await update($, planA, () => plan)
    return plan
  } catch (err) {
    $.ui.log(`chantier: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return null
  }
}

async function savePlan($: $, config: Config, plan: Plan): Promise<string> {
  const path = planPath(await homeOf($), config.planDir, plan.epic)
  await $.fs.write(path, `${JSON.stringify(plan, null, 2)}\n`)
  await $.store.set('activeEpic', plan.epic)
  await update($, planA, () => plan)
  return path
}

async function refreshHere($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const toplevel = await git($, cwd, 'rev-parse', '--show-toplevel')
  const branch = toplevel ? await git($, cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null
  const here: Here = { toplevel, branch, ticket: ticketOf(branch) }
  await update($, hereA, () => here)
}

/* ---------- prompts handed to the person, who reads them before sending ---------- */

function planningPrompt(epic: string): string {
  return [
    `Break chantier ${epic} into briques and propose the plan with the plan_write tool. Open no session and change no code.`,
    `1. Read the epic ${epic}, its child tickets, and the branches or PRs already open for them.`,
    '2. For each ticket, find the repos and folders it touches (git grep, git log).',
    `3. One brique = 1 ticket = 1 repo = 1 branch = 1 PR. Lane = the repo, or the part of a repo that moves separately (backend, console); "${YOU_LANE}" for a decision of mine.`,
    '4. Waves: everything in one wave runs in parallel. Different repos with no dependency: same wave. Same repo, separate folders: parallel, risk noted. Same files: one after the other. Dependency through a release (library to module, endpoint to UI): next wave, noted "can start on a local build". Repeated change (backports, N modules): executor workflow. Blocking decision: executor you. Work already merged: wave 0, status done.',
  ].join('\n')
}

function goPrompt(plan: Plan): string | null {
  const wave = currentWave(plan)
  if (wave === null) return null
  const inWave = plan.briques.filter(b => b.wave === wave && !isDone(b))
  const ready = inWave.filter(b => waitsOn(plan, b).length === 0)
  const sessions = ready.filter(b => b.executor === 'session').map(b => b.id)
  const workflows = ready.filter(b => b.executor === 'workflow').map(b => b.id)
  const decisions = inWave.filter(b => b.executor === 'you').map(b => `${b.id} (${b.title})`)
  const blocked = inWave.filter(b => waitsOn(plan, b).length > 0).map(b => `${b.id} waits on ${waitsOn(plan, b).join(', ')}`)
  return [
    `Start wave ${wave} of chantier ${plan.epic}.`,
    sessions.length ? `Session briques (${sessions.join(', ')}): start one linked session per brique, each in its own worktree, with a brief (ticket, repo, branch, satisfied dependencies, decisions taken), then call brique_update (status running, branch, worktree).` : '',
    workflows.length ? `Workflow briques (${workflows.join(', ')}): propose the workflow without running it.` : '',
    decisions.length ? `Open decisions: ${decisions.join('; ')}. Ask me first.` : '',
    blocked.length ? `Start nothing for ${blocked.join('; ')}.` : '',
  ].filter(Boolean).join('\n')
}

function sessionPrompt(pr: PrItem): string {
  return pr.worktree
    ? `Open the session working in ${pr.worktree} (branch ${pr.branch}, ${pr.url}). If there is none, start a session in that worktree.`
    : `Pick up ${pr.url} (${pr.title}): start a session in a new worktree on branch ${pr.branch}.`
}

async function fill($: $, text: string): Promise<void> {
  await $.prompt.fill({ text, mode: 'replace' })
}

/* ---------- drawing ---------- */

const GROUPS: { id: string; label: string; of: PrGroup[] }[] = [
  { id: 'act', label: 'Needs you', of: ['need', 'ready'] },
  { id: 'review', label: 'Waiting for review', of: ['review'] },
  { id: 'draft', label: 'Drafts', of: ['draft'] },
  { id: 'stale', label: 'Stale', of: ['stale'] },
]
const PR_MARK: Record<PrGroup, { glyph: string; color: ThemeKey }> = {
  need: { glyph: '✗', color: 'error' },
  ready: { glyph: '✓', color: 'success' },
  review: { glyph: '◎', color: 'suggestion' },
  draft: { glyph: '◌', color: 'inactive' },
  stale: { glyph: '☾', color: 'inactive' },
}
const STATUS_MARK: Record<BriqueStatus, { glyph: string; color: ThemeKey; label: string }> = {
  done: { glyph: '✓', color: 'success', label: 'done' },
  running: { glyph: '●', color: 'suggestion', label: 'running' },
  waiting: { glyph: '?', color: 'warning', label: 'waiting on you' },
  blocked: { glyph: '‖', color: 'error', label: 'blocked' },
  todo: { glyph: '○', color: 'inactive', label: 'to do' },
}

function age(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d`
  const d = new Date(Date.parse(iso))
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function ago(at: number, now: number): string {
  if (at === 0) return 'never fetched'
  const min = Math.round((now - at) / 60_000)
  return min < 1 ? 'fetched just now' : `fetched ${min} min ago`
}

function shortRepo(repo: string): string {
  return repo.length > 22 ? `…${repo.slice(-21)}` : repo
}

function prReasons(pr: PrItem): { text: string; color: ThemeKey }[] {
  const out: { text: string; color: ThemeKey }[] = []
  const total = pr.checks.ok + pr.checks.fail + pr.checks.pending
  if (pr.group === 'ready') out.push({ text: 'ready to merge', color: 'success' })
  if (pr.isConflict) out.push({ text: 'conflict', color: 'error' })
  if (pr.checks.fail) out.push({ text: `${pr.checks.fail} checks failed`, color: 'error' })
  if (pr.review === 'CHANGES_REQUESTED') out.push({ text: 'changes requested', color: 'error' })
  if (pr.review === 'APPROVED') out.push({ text: 'approved', color: 'success' })
  if (pr.review === 'REVIEW_REQUIRED' && !pr.isDraft) out.push({ text: 'review required', color: 'subtle' })
  if (pr.checks.pending) out.push({ text: `CI ${pr.checks.ok}/${total} running`, color: 'suggestion' })
  else if (total && !pr.checks.fail) out.push({ text: `CI ${total}/${total}`, color: 'success' })
  if (pr.backportOf) out.push({ text: `backport of #${pr.backportOf} to ${pr.base}`, color: 'subtle' })
  return out
}

function TicketLink(ui: UI, config: Config, ticket: string) {
  const { Link, Text } = ui
  return config.ticketUrl ? <Link href={`${config.ticketUrl}${ticket}`} label={ticket} /> : <Text mono>{ticket}</Text>
}

function Switcher(ui: UI, $: $, view: View, actCount: number) {
  const { Box, Button } = ui
  const tabs: { id: View; label: string }[] = [
    { id: 'pr', label: actCount ? `PRs · ${actCount}` : 'PRs' },
    { id: 'plan', label: 'Plan' },
    { id: 'run', label: 'Run' },
    { id: 'land', label: 'Landing' },
  ]
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {tabs.map(t => (
        <Button key={`view-${t.id}`} label={t.label} variant={t.id === view ? 'primary' : 'secondary'} onPress={() => update($, viewA, () => t.id)} />
      ))}
    </Box>
  )
}

function Section(ui: UI, label: string, count?: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" gap={1} marginTop={1}>
      <Text weight="semibold">{label}</Text>
      {count !== undefined && <Text dimColor tabular>{String(count)}</Text>}
    </Box>
  )
}

function PrRow(ui: UI, $: $, config: Config, pr: PrItem, now: number) {
  const { Box, Text, Button, Link } = ui
  const mark = PR_MARK[pr.group]
  return (
    <Box key={`pr-${pr.repo}-${pr.number}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={mark.color}>{mark.glyph}</Text>
        <Text mono dimColor>{`${shortRepo(pr.repo)}#${pr.number}`}</Text>
        <Box flexGrow={1}><Text wrap="truncate-end">{pr.title}</Text></Box>
        <Text dimColor tabular>{age(pr.updatedAt, now)}</Text>
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2}>
        {prReasons(pr).map(r => <Text size="footnote" color={r.color}>{r.text}</Text>)}
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap" paddingLeft={2}>
        <Link href={pr.url} label="PR" />
        <Button key={`sess-${pr.repo}-${pr.number}`} plain onPress={() => fill($, sessionPrompt(pr))}>
          {pr.worktree ? `Session · ${pr.worktree.split('/').pop()}` : 'Pick up in a session'}
        </Button>
        {pr.ticket ? TicketLink(ui, config, pr.ticket) : <Text dimColor>no ticket</Text>}
      </Box>
    </Box>
  )
}

function PrView(ui: UI, $: $, config: Config, snap: PrSnapshot | null, now: number) {
  const { Box, Text, Button } = ui
  if (!snap) return <Text dimColor>Fetching your PRs…</Text>
  const repos = new Set(snap.items.map(p => p.repo)).size
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1}><Text dimColor size="footnote">{`${snap.items.length} open PRs · ${repos} repos · ${ago(snap.at, now)}`}</Text></Box>
        <Button key="refresh" plain label="Refresh" onPress={() => void refreshPrs($, config, true)} />
      </Box>
      {snap.error && <Text color="error" size="footnote">{`Fetch failed: ${snap.error}`}</Text>}
      {GROUPS.map(g => {
        const rows = snap.items.filter(p => g.of.includes(p.group)).sort((a, b) => Number(b.group === 'need') - Number(a.group === 'need'))
        if (!rows.length) return null
        return (
          <Box key={`grp-${g.id}`} flexDirection="column">
            {Section(ui, g.label, rows.length)}
            {rows.map(pr => PrRow(ui, $, config, pr, now))}
          </Box>
        )
      })}
      {snap.items.length === 0 && !snap.error && <Text dimColor>No open PRs.</Text>}
    </Box>
  )
}

function NoPlan(ui: UI, $: $) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>No active chantier.</Text>
      <Text>Type /chantier followed by your epic's key: Claude reads the tickets and the code, then proposes here a breakdown per repo and wave, for you to approve before anything starts.</Text>
      <Button key="start-plan" label="Plan a chantier…" onPress={() => fill($, '/chantier ')} />
    </Box>
  )
}

function BriqueLine(ui: UI, plan: Plan, b: Brique) {
  const { Box, Text } = ui
  const mark = STATUS_MARK[b.status]
  const waits = waitsOn(plan, b)
  const detail = [waits.length ? `waits on ${waits.join(', ')}` : '', b.note ?? ''].filter(Boolean).join(' · ')
  return (
    <Box key={`b-${b.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={mark.color}>{mark.glyph}</Text>
        <Text mono weight="semibold">{b.id}</Text>
        {b.ticket && <Text mono dimColor>{b.ticket}</Text>}
        <Box flexGrow={1}><Text wrap="truncate-end">{b.title}</Text></Box>
        <Text dimColor size="footnote">{b.executor}</Text>
      </Box>
      {detail && <Box paddingLeft={2}><Text dimColor size="footnote" wrap="wrap">{detail}</Text></Box>}
    </Box>
  )
}

function PlanView(ui: UI, $: $, plan: Plan | null) {
  const { Box, Text, Button } = ui
  if (!plan) return NoPlan(ui, $)
  const waves = [...new Set(plan.briques.map(b => b.wave))].sort((a, b) => a - b)
  const wave = currentWave(plan)
  const go = goPrompt(plan)
  return (
    <Box flexDirection="column">
      <Text weight="semibold">{`${plan.epic} · ${plan.title}`}</Text>
      <Text dimColor size="footnote">{`${plan.briques.length} briques · ${lanes(plan).length} lanes · ${wave === null ? 'all done' : `current wave ${wave}`}`}</Text>
      {waves.map(w => {
        const inWave = plan.briques.filter(b => b.wave === w)
        const parallel = inWave.filter(b => b.executor === 'session' && !isDone(b)).length
        const summary = inWave.every(isDone) ? 'done' : parallel > 1 ? `${parallel} sessions in parallel` : `${inWave.length} brique${inWave.length > 1 ? 's' : ''}`
        return (
          <Box key={`wave-${w}`} flexDirection="column">
            {Section(ui, `Wave ${w}`)}
            <Text dimColor size="footnote">{summary}</Text>
            {lanes(plan).filter(l => inWave.some(b => b.lane === l)).map(l => (
              <Box key={`lane-${w}-${l}`} flexDirection="column" paddingLeft={1}>
                <Text color={l === YOU_LANE ? 'warning' : 'subtle'} size="footnote" weight="medium">{l}</Text>
                {inWave.filter(b => b.lane === l).map(b => BriqueLine(ui, plan, b))}
              </Box>
            ))}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        {go && <Button key="go" variant="primary" label={`Start wave ${wave}`} onPress={() => fill($, go)} />}
        <Button key="edit-plan" label="Change the plan" onPress={() => fill($, `Change the plan of chantier ${plan.epic}: `)} />
      </Box>
    </Box>
  )
}

function prOf(snap: PrSnapshot | null, b: Brique): PrItem | undefined {
  return snap?.items.find(p => (b.pr && p.repo === b.pr.repo && p.number === b.pr.number) || (b.branch !== undefined && p.branch === b.branch))
}

function RunView(ui: UI, $: $, plan: Plan | null, snap: PrSnapshot | null) {
  const { Box, Text, Button } = ui
  if (!plan) return NoPlan(ui, $)
  const waiting = plan.briques.filter(b => b.status === 'waiting')
  const running = plan.briques.filter(b => b.status === 'running')
  const blocked = plan.briques.filter(b => !isDone(b) && b.status !== 'running' && waitsOn(plan, b).length > 0)
  return (
    <Box flexDirection="column">
      {Section(ui, 'Waiting on you', waiting.length)}
      {waiting.length === 0 && <Text dimColor size="footnote">No open question.</Text>}
      {waiting.map(b => (
        <Box key={`ask-${b.id}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text weight="semibold">{`${b.id} · ${b.lane}`}</Text>
          <Text wrap="wrap">{b.question ?? b.note ?? 'No question text'}</Text>
          <Button key={`ask-open-${b.id}`} plain label="Open its session" onPress={() => fill($, `Open the session of brique ${b.id} of chantier ${plan.epic}${b.worktree ? ` (worktree ${b.worktree})` : ''}.`)} />
        </Box>
      ))}
      {Section(ui, 'Per repo')}
      {lanes(plan).map(l => (
        <Box key={`strip-${l}`} flexDirection="row" gap={1} flexWrap="wrap">
          <Box width={16}><Text dimColor wrap="truncate-end">{l}</Text></Box>
          {plan.briques.filter(b => b.lane === l).map(b => (
            <Text color={STATUS_MARK[b.status].color}>{`${STATUS_MARK[b.status].glyph} ${b.id}`}</Text>
          ))}
        </Box>
      ))}
      {Section(ui, 'Running', running.length)}
      {running.map(b => {
        const pr = prOf(snap, b)
        return (
          <Box key={`run-${b.id}`} flexDirection="column">
            {BriqueLine(ui, plan, b)}
            {pr && <Box paddingLeft={2} flexDirection="row" gap={1} flexWrap="wrap">{prReasons(pr).map(r => <Text size="footnote" color={r.color}>{r.text}</Text>)}</Box>}
          </Box>
        )
      })}
      {blocked.length > 0 && Section(ui, 'Blocked', blocked.length)}
      {blocked.map(b => <Text dimColor>{`${b.id} waits on ${waitsOn(plan, b).join(', ')}`}</Text>)}
    </Box>
  )
}

function LandView(ui: UI, $: $, plan: Plan | null, snap: PrSnapshot | null) {
  const { Box, Text, Button, Link } = ui
  const backports = (snap?.items ?? []).filter(p => p.backportOf !== null)
  const bySource = new Map<number, PrItem[]>()
  for (const p of backports) bySource.set(p.backportOf as number, [...(bySource.get(p.backportOf as number) ?? []), p])
  const order = plan ? mergeOrder(plan) : []
  const trees = plan?.briques.filter(b => b.worktree) ?? []
  return (
    <Box flexDirection="column">
      {plan ? Section(ui, `Merge order · ${plan.epic}`) : NoPlan(ui, $)}
      {order.map((b, i) => {
        const pr = prOf(snap, b)
        return (
          <Box key={`land-${b.id}`} flexDirection="row" gap={1}>
            <Text dimColor tabular>{`${i + 1}.`}</Text>
            <Text color={STATUS_MARK[b.status].color}>{STATUS_MARK[b.status].glyph}</Text>
            <Text mono weight="semibold">{b.id}</Text>
            <Box flexGrow={1}><Text wrap="truncate-end">{b.title}</Text></Box>
            {pr ? <Link href={pr.url} label={`#${pr.number}`} /> : <Text dimColor size="footnote">{isDone(b) ? 'merged' : 'no PR'}</Text>}
          </Box>
        )
      })}
      {plan && <Button key="tickets" plain label="Prepare the ticket transitions" onPress={() => fill($, `Prepare the ticket transitions of chantier ${plan.epic}: for each brique, the status its ticket should have given its PR. Transition nothing without my go-ahead.`)} />}
      {Section(ui, 'Open backports', backports.length)}
      {backports.length === 0 && <Text dimColor size="footnote">No open Mergify backport.</Text>}
      {[...bySource.entries()].map(([source, list]) => (
        <Box key={`bp-${source}`} flexDirection="row" gap={1} flexWrap="wrap">
          <Text mono>{`#${source}`}</Text>
          {list.map(p => <Link href={p.url} label={`${p.base} #${p.number} ${p.isConflict || p.checks.fail ? '✗' : p.group === 'ready' ? '✓ ready' : '◎'}`} />)}
        </Box>
      ))}
      {plan && Section(ui, 'Chantier worktrees', trees.length)}
      {trees.map(b => <Text dimColor size="footnote">{`${b.id} · ${b.worktree}${isDone(b) ? ' · to clean' : ''}`}</Text>)}
    </Box>
  )
}

/* ---------- the mod ---------- */

export const register: Register = (on, options) => {
  const config = configOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'chantier',
      description: 'Chantier pane: open PRs, a plan per repo and wave, who waits on you, landing',
      argumentHint: '[prs | plan | run | land | go | status | refresh | export | off | <EPIC>]',
    })
    await $.tool.register({
      name: 'plan_write',
      description: 'Writes the chantier plan the person reviews in the Chantier pane: briques (1 ticket, 1 repo, 1 branch, 1 PR) grouped in lanes (a repo, or a part of a repo that moves separately; "You" for the person\'s decisions) and waves (same wave = in parallel). Replaces any plan with the same epic and makes it the active chantier. Starts nothing.',
      inputSchema: PLAN_SCHEMA,
    })
    await $.tool.register({
      name: 'brique_update',
      description: 'Updates one brique of the active chantier: status (todo, running, waiting with a question for the person, blocked, done), note, branch, worktree, PR, wave or executor. Call it when a linked session reports back or a brique changes state.',
      inputSchema: UPDATE_SCHEMA,
    })
    void (async () => {
      await refreshHere($)
      await loadPlan($, config)
      await refreshPrs($, config)
    })()
    $.clock.every(PR_POLL_MS, () => void refreshPrs($, config).then(() => loadPlan($, config)))
    $.clock.every(HERE_POLL_MS, () => void refreshHere($))
    return started
  })

  on('command.run', { command: 'chantier' }, async ($, e) => {
    const arg = e.args.trim()
    const word = (arg.split(/\s+/)[0] ?? '').toLowerCase()
    const open = async (view?: View) => {
      if (view) await update($, viewA, () => view)
      await $.ui.open({ id: PANE, title: TITLE })
    }
    if (word === '' || word === 'prs' || word === 'pr') {
      await open(word ? 'pr' : undefined)
      void refreshPrs($, config)
      return { text: 'Chantier pane opened.' }
    }
    if (word === 'plan' || word === 'run' || word === 'land') {
      await loadPlan($, config)
      await open(word)
      return { text: `Chantier pane: ${word}.` }
    }
    if (word === 'refresh') {
      const snap = await refreshPrs($, config, true)
      await loadPlan($, config)
      return { text: snap?.error ? `Fetch failed: ${snap.error}` : `${snap?.items.length ?? 0} PRs fetched.` }
    }
    if (word === 'off') {
      await $.store.delete('activeEpic')
      await update($, planA, () => null)
      return { text: `No active chantier. Plans stay in ~/${config.planDir}.` }
    }
    if (word === 'status') {
      const snap = (await read($, prsA)) ?? (await refreshPrs($, config))
      const plan = await loadPlan($, config)
      const act = snap?.items.filter(p => p.group === 'need' || p.group === 'ready').length ?? 0
      const waiting = plan?.briques.filter(b => b.status === 'waiting').map(b => b.id) ?? []
      const planLine = plan ? `${plan.epic}: wave ${currentWave(plan) ?? '—'}, ${waiting.length ? `${waiting.join(', ')} waiting on you` : 'no open question'}.` : 'No active chantier.'
      return { text: `${act} PRs need you. ${planLine}` }
    }
    if (word === 'go' || word === 'export') {
      const plan = await loadPlan($, config)
      if (!plan) return { text: 'No active chantier: run /chantier <EPIC> first.' }
      if (word === 'export') {
        await fill($, `Export chantier ${plan.epic} as a shareable page (KPIs, one row per brique, PR and ticket links), from ~/${config.planDir}/${plan.epic}.json and the PR states.`)
        return { text: 'The prompt is in the input box: read it, then send.' }
      }
      const prompt = goPrompt(plan)
      if (!prompt) return { text: `Chantier ${plan.epic}: everything is done.` }
      await fill($, prompt)
      return { text: 'The launch prompt is in the input box: read it, then send.' }
    }
    const epic = arg.toUpperCase()
    if (EPIC.test(epic)) {
      if (await loadPlan($, config, epic)) {
        await $.store.set('activeEpic', epic)
        await open('plan')
        return { text: `Chantier ${epic} is active.` }
      }
      await fill($, planningPrompt(epic))
      await open('plan')
      return { text: `No plan yet for ${epic}: the planning prompt is in the input box.` }
    }
    return { text: 'Usage: /chantier [prs | plan | run | land | go | status | refresh | export | off | <EPIC>]' }
  })

  on('tool.call', { tool: 'mcp__chantier__plan_write' }, async ($, e) => {
    const checked = validatePlan(e as unknown as Record<string, unknown>, new Date(await $.clock.now()).toISOString())
    if ('errors' in checked) return { result: `Plan refused:\n- ${checked.errors.join('\n- ')}` }
    const path = await savePlan($, config, checked.plan)
    await update($, viewA, () => 'plan')
    await $.ui.open({ id: PANE, title: TITLE })
    const waves = new Set(checked.plan.briques.map(b => b.wave)).size
    return { result: `Plan ${checked.plan.epic} saved to ${path}: ${checked.plan.briques.length} briques in ${waves} waves, shown in the Chantier pane. Wait for the person to approve it before starting anything.` }
  })

  on('tool.call', { tool: 'mcp__chantier__brique_update' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const epic = typeof input.epic === 'string' ? input.epic.toUpperCase() : undefined
    const plan = await loadPlan($, config, epic)
    if (!plan) return { result: 'No active chantier: call plan_write first.' }
    const applied = applyUpdate(plan, input, new Date(await $.clock.now()).toISOString())
    if ('error' in applied) return { result: applied.error }
    await savePlan($, config, applied.plan)
    const b = applied.plan.briques.find(x => x.id === input.id) as Brique
    if (b.status === 'waiting') $.ui.toast(`${b.id} waits on you: ${b.question ?? b.note ?? ''}`.trim(), { timeoutMs: 15_000 })
    if (b.status === 'done') {
      const next = unblocks(applied.plan, b.id)
      if (next.length) $.ui.toast(`${b.id} done: unblocks ${next.join(', ')}. /chantier go starts them.`, { timeoutMs: 15_000 })
    }
    return { result: `${b.id}: ${STATUS_MARK[b.status].label}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const plan = await read($, planA)
    if (!plan) return composed
    const text = `Active chantier: ${plan.epic} (${plan.briques.length} briques, plan in ~/${config.planDir}/${plan.epic}.json, shown in the Chantier pane). When a linked session reports back or a brique changes state, update it with brique_update. A question for the person: status waiting with the question.`
    return { sections: [...composed.sections, { id: 'chantier', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui: UI = $.ui.resolve(e)
    const { Box } = ui
    const view = await read($, viewA)
    const snap = await read($, prsA)
    const plan = await read($, planA)
    const now = await $.clock.now()
    const act = snap?.items.filter(p => p.group === 'need' || p.group === 'ready').length ?? 0
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {Switcher(ui, $, view, act)}
        {view === 'pr' && PrView(ui, $, config, snap, now)}
        {view === 'plan' && PlanView(ui, $, plan)}
        {view === 'run' && RunView(ui, $, plan, snap)}
        {view === 'land' && LandView(ui, $, plan, snap)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const here = await read($, hereA)
    const snap = await read($, prsA)
    const plan = await read($, planA)
    const pr = here?.branch ? snap?.items.find(p => p.branch === here.branch) : undefined
    const brique = plan?.briques.find(b => (here?.branch && b.branch === here.branch) || (here?.toplevel && b.worktree === here.toplevel))
    const ticket = brique?.ticket ?? pr?.ticket ?? here?.ticket ?? null
    if (!ticket && !pr && !brique) return next(e)
    const ui: UI = $.ui.resolve(e)
    const { Box, Text, Link } = ui
    const unblocked = brique && plan ? unblocks(plan, brique.id) : []
    const waits = brique && plan ? waitsOn(plan, brique) : []
    return (
      <Box flexDirection="row" gap={2} flexWrap="wrap" paddingX={1}>
        {brique && <Text weight="semibold">{`${brique.id} · wave ${brique.wave}`}</Text>}
        {ticket && TicketLink(ui, config, ticket)}
        {waits.length > 0 && <Text color="warning">{`waits on ${waits.join(', ')}`}</Text>}
        {unblocked.length > 0 && <Text dimColor>{`unblocks ${unblocked.join(', ')}`}</Text>}
        {pr && <Link href={pr.url} label={`#${pr.number}`} />}
        {pr && prReasons(pr).slice(0, 3).map(r => <Text color={r.color}>{r.text}</Text>)}
        {!pr && here?.branch && <Text dimColor>no PR</Text>}
      </Box>
    )
  })
}
