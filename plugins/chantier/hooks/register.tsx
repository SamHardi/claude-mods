import { atom, read, update } from 'claude-code'
import type {
  BoxProps, ButtonProps, ElementConstructor, EngineInterface, LinkProps, Register, RenderChildren, SelectProps, SvgProps, TextProps, ThemeKey,
} from 'claude-code'

import type { Brique, BriqueStatus, Here, Plan, PrFilter, PrItem, PrSnapshot, SessionRef, View } from '../types'
import { BIN, HERE_POLL_MS, MAX_TOASTS_PER_REFRESH, PR_POLL_MS, PR_TTL_MS, configOf, repoLabel } from './config'
import type { Config } from './config'
import { changes, fetchPrs, isCiStuck, parseSessions, sessionFor, ticketOf } from './prs'
import type { AppSession, Run } from './prs'
import { GLYPH_CHAR, SPINNER_SVG, TONE_KEY, pillsSvg } from './pills'
import type { Pill } from './pills'
import { FILTERS, actionOf, nextUp, prPills, routed, shown, whyOf } from './triage'
import {
  PLAN_SCHEMA, UPDATE_SCHEMA, YOU_LANE, applyUpdate, currentWave, isDone, lanes, mergeOrder, planPath, unblocks, validatePlan, waitsOn,
} from './plan'

type $ = EngineInterface
type UI = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Link: ElementConstructor<LinkProps>
  /** Where the surface draws SVG (desktop, VS Code); the terminal's table answers it with nothing drawn. */
  Svg?: ElementConstructor<SvgProps>
  Select?: ElementConstructor<SelectProps>
}

const PANE = 'chantier'
const TITLE = 'Chantier'
const EPIC = /^[A-Z][A-Z0-9]+-\d+$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const prsA = atom({ plugin: 'chantier', key: 'prs' } as const, null)
const viewA = atom({ plugin: 'chantier', key: 'view' } as const, 'pr')
const planA = atom({ plugin: 'chantier', key: 'plan' } as const, null)
const hereA = atom({ plugin: 'chantier', key: 'here' } as const, null)
const filterA = atom({ plugin: 'chantier', key: 'filter' } as const, 'all')
const repoA = atom({ plugin: 'chantier', key: 'repo' } as const, '')

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

const LIST_SESSIONS = 'mcp__ccd_session_mgmt__list_sessions'

/** The app's open sessions, when this session may list them without asking; none otherwise. */
async function listSessions($: $): Promise<AppSession[]> {
  try {
    const verdict = await $.tool.check({ tool: LIST_SESSIONS, input: { limit: 200 } } as Parameters<$['tool']['check']>[0])
    if (verdict.decision !== 'allow') return []
    return parseSessions(await $.tool.call({ tool: LIST_SESSIONS, limit: 200 } as Parameters<$['tool']['call']>[0]))
  } catch (err) {
    $.ui.log(`chantier: cannot list sessions: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return []
  }
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
    const sessions = await listSessions($)
    const items = (await fetchPrs(runner($), await homeOf($), now, config)).map(p => ({ ...p, session: sessionFor(p, sessions) }))
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
  await refreshStatus($)
  return path
}

async function refreshHere($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const toplevel = await git($, cwd, 'rev-parse', '--show-toplevel')
  const branch = toplevel ? await git($, cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null
  const here: Here = { toplevel, branch, ticket: ticketOf(branch) }
  await update($, hereA, () => here)
}

/**
 * This session's place in the work, as a status line entry: its ticket and, in a chantier, its brique.
 * Nothing the app already shows (branch, diff, PR and its checks): the band above the prompt stays the app's own.
 */
async function refreshStatus($: $): Promise<void> {
  const here = await read($, hereA)
  const plan = await read($, planA)
  const brique = plan?.briques.find(b => (here?.branch && b.branch === here.branch) || (here?.toplevel && b.worktree === here.toplevel))
  const ticket = brique?.ticket ?? here?.ticket ?? null
  const waits = brique && plan ? waitsOn(plan, brique) : []
  const next = brique && plan ? unblocks(plan, brique.id) : []
  const parts = [
    ticket ?? '',
    brique && plan ? `${plan.epic} ${brique.id} · wave ${brique.wave}` : '',
    waits.length ? `waits on ${waits.join(', ')}` : '',
    next.length ? `unblocks ${next.join(', ')}` : '',
  ].filter(Boolean)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
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
    sessions.length ? `Session briques (${sessions.join(', ')}): start one linked session per brique, each in its own worktree, titled \`<ticket> | <brique title>\`, with a brief (ticket, repo, branch, satisfied dependencies, decisions taken), then call brique_update (status running, branch, worktree).` : '',
    `File this lead session in the sidebar section \`${plan.epic} · ${plan.title}\` (create it if it does not exist yet); linked sessions follow their lead.`,
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

/** Shows a session in the desktop app: a Link cannot (the app draws only https links), the OS hands it the claude:// link. */
async function goToSession($: $, session: SessionRef): Promise<void> {
  if (!session.link?.startsWith('claude://')) return
  const { exitCode, stderr } = await runner($)(['open', session.link])
  if (exitCode !== 0) $.ui.toast(`Cannot open ${session.title}: ${stderr.trim() || `open exited ${exitCode}`}`, { timeoutMs: 8_000 })
}

/* ---------- drawing ---------- */
// Spacing uses the surface's own steps (xs…xl), never cell counts: on desktop a step follows the app's
// spacing scale, so the pane reads like the app rather than a terminal. Status reads as pills: one SVG per
// row where the surface draws SVG, coloured words on the terminal.

/** What a press does, closed over the engine: a drawing never holds `$` itself. */
type Acts = {
  fill: (text: string) => void
  view: (view: View) => void
  filter: (filter: PrFilter) => void
  repo: (repo: string) => void
  refresh: () => void
  goTo: (session: SessionRef) => void
}

/** What every drawing function needs: the elements, the settings, the time, the room for pills, and the presses. */
type Ctx = { ui: UI; config: Config; now: number; /** CSS pixels a row of pills may take. */ px: number; act: Acts }

const STATUS_PILL: Record<BriqueStatus, Pill> = {
  done: { text: 'Done', tone: 'green', glyph: 'check' },
  running: { text: 'Running', tone: 'blue', glyph: 'dot' },
  waiting: { text: 'Waiting on you', tone: 'amber', glyph: 'clock' },
  blocked: { text: 'Blocked', tone: 'red', glyph: 'cross' },
  todo: { text: 'To do', tone: 'grey', glyph: 'dot' },
}

function age(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  const d = new Date(Date.parse(iso))
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function ago(at: number, now: number): string {
  if (at === 0) return 'never fetched'
  const min = Math.round((now - at) / 60_000)
  return min < 1 ? 'updated just now' : `updated ${min} min ago`
}

function Pills(c: Ctx, pills: Pill[]) {
  const { Box, Text, Svg } = c.ui
  if (!pills.length) return null
  if (!Svg) {
    return (
      <Box flexDirection="row" gap="sm" flexWrap="wrap">
        {pills.map(p => <Text size="footnote" weight="medium" color={TONE_KEY[p.tone]}>{p.glyph ? `${GLYPH_CHAR[p.glyph]} ${p.text}` : p.text}</Text>)}
      </Box>
    )
  }
  const svg = pillsSvg(pills, c.px)
  return <Svg source={svg.source} alt={pills.map(p => p.text).join(', ')} width={svg.width} height={svg.height} />
}

function Card(c: Ctx, key: string, accent: ThemeKey | null, children: RenderChildren[]) {
  const { Box } = c.ui
  return (
    <Box key={key} flexDirection="column" gap="xs" paddingX="md" paddingY="sm" borderStyle={accent ? 'bold' : 'round'}
      borderColor={accent ?? 'promptBorder'} {...(accent ? {} : { hover: { borderColor: 'suggestion' } })}>
      {children}
    </Box>
  )
}

function TicketLink(c: Ctx, ticket: string) {
  const { Link, Text } = c.ui
  return c.config.ticketUrl ? <Link href={`${c.config.ticketUrl}${ticket}`} label={ticket} /> : <Text dimColor>{ticket}</Text>
}

function Switcher(c: Ctx, view: View, actCount: number) {
  const { Box, Button } = c.ui
  const tabs: { id: View; label: string }[] = [
    { id: 'pr', label: actCount ? `PRs · ${actCount}` : 'PRs' },
    { id: 'plan', label: 'Plan' },
    { id: 'run', label: 'Run' },
    { id: 'land', label: 'Landing' },
  ]
  return (
    <Box flexDirection="row" gap="xs" flexWrap="wrap">
      {tabs.map(t => (
        <Button key={`view-${t.id}`} label={t.label} variant={t.id === view ? 'primary' : 'secondary'} onPress={() => c.act.view(t.id)} />
      ))}
    </Box>
  )
}

function Section(c: Ctx, key: string, label: string, count: number | null, children: RenderChildren[]) {
  const { Box, Text } = c.ui
  return (
    <Box key={key} flexDirection="column" gap="sm" marginTop="md">
      <Box flexDirection="row" gap="sm" alignItems="center">
        <Text size="heading" weight="semibold">{label}</Text>
        {count !== null && <Text size="footnote" dimColor tabular>{String(count)}</Text>}
      </Box>
      {children}
    </Box>
  )
}

/** `#134 · ui · 2d ago · PROJ-165`: the PR number and the ticket are links. */
function PrMeta(c: Ctx, pr: PrItem) {
  const { Box, Text, Link } = c.ui
  const where = [repoLabel(c.config, pr.repo), age(pr.updatedAt, c.now), pr.backportOf ? `backport of #${pr.backportOf}` : ''].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
      <Link href={pr.url} label={`#${pr.number}`} />
      <Text dimColor>{`· ${where}`}</Text>
      {pr.ticket && <Text dimColor>·</Text>}
      {pr.ticket && TicketLink(c, pr.ticket)}
    </Box>
  )
}

/** Who works on the PR: a button to its session, with its title; or a button to start one. */
function SessionControl(c: Ctx, pr: PrItem, isQuiet: boolean) {
  const { Box, Text, Button } = c.ui
  const id = `${pr.repo}-${pr.number}`
  const session = pr.session
  if (!session) {
    return <Button key={`sess-${id}`} {...(isQuiet ? { plain: true, dimColor: true } : { variant: 'secondary' })} label="Start a session" onPress={() => c.act.fill(sessionPrompt(pr))} />
  }
  return (
    <Box flexDirection="row" gap="sm" alignItems="center" flexShrink={1}>
      {session.link && <Button key={`goto-${id}`} {...(isQuiet ? { plain: true, dimColor: true } : { variant: 'secondary' })} label="Go to session" onPress={() => c.act.goTo(session)} />}
      <Text size="footnote" dimColor wrap="truncate-end">{session.title}</Text>
    </Box>
  )
}

/** The PR's job as a button, then the session working on it. */
function PrActions(c: Ctx, pr: PrItem, isMain: boolean) {
  const { Box, Button } = c.ui
  const action = actionOf(pr, c.now)
  return (
    <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap" marginTop="xs">
      {action && <Button key={`act-${pr.repo}-${pr.number}`} variant={isMain ? 'primary' : 'secondary'} label={action.label} onPress={() => c.act.fill(routed(pr, action.task))} />}
      {SessionControl(c, pr, false)}
    </Box>
  )
}

/** The one PR to take now, with why and the button that hands the job to its session. */
function NextUp(c: Ctx, pr: PrItem) {
  const { Box, Text } = c.ui
  return (
    <Box key="next-up" flexDirection="column" gap="xs" paddingX="md" paddingY="sm" marginTop="sm" borderStyle="bold" borderColor="claude">
      <Text size="footnote" weight="semibold" color="claude">Next up</Text>
      <Text weight="semibold" wrap="wrap">{pr.title}</Text>
      {PrMeta(c, pr)}
      <Text wrap="wrap">{whyOf(pr, c.now)}</Text>
      {Pills(c, prPills(pr, c.now))}
      {PrActions(c, pr, true)}
    </Box>
  )
}

/** A PR that waits on you: a card, red or green by what it needs. */
function PrCard(c: Ctx, pr: PrItem) {
  const { Text } = c.ui
  const accent: ThemeKey | null = pr.group === 'need' ? 'diffRemoved' : pr.group === 'ready' ? 'diffAdded' : null
  return Card(c, `pr-${pr.repo}-${pr.number}`, accent, [
    <Text weight="medium" wrap="wrap">{pr.title}</Text>,
    PrMeta(c, pr),
    Pills(c, prPills(pr, c.now)),
    PrActions(c, pr, false),
  ])
}

/** A PR that waits on someone else: a light row that lights up under the pointer. */
function PrRow(c: Ctx, pr: PrItem) {
  const { Box, Text } = c.ui
  const id = `${pr.repo}-${pr.number}`
  return (
    <Box key={`row-${id}`} flexDirection="column" gap="xs" paddingX="md" paddingY="xs">
      <Text weight="medium" wrap="wrap" hover={{ color: 'suggestion' }}>{pr.title}</Text>
      {PrMeta(c, pr)}
      <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
        {Pills(c, prPills(pr, c.now))}
        <Box flexGrow={1} />
        {SessionControl(c, pr, true)}
      </Box>
    </Box>
  )
}

function Spinner(c: Ctx, text: string) {
  const { Box, Text, Svg } = c.ui
  return (
    <Box flexDirection="row" gap="sm" alignItems="center">
      {Svg ? <Svg source={SPINNER_SVG} alt="Loading" width={14} height={14} isInteractive /> : <Text color="claude">◌</Text>}
      <Text size="footnote" dimColor>{text}</Text>
    </Box>
  )
}

function PrView(c: Ctx, snap: PrSnapshot | null, filter: PrFilter, repo: string, isFetching: boolean) {
  const { Box, Text, Button, Select } = c.ui
  if (!snap) return Spinner(c, 'Fetching your pull requests…')
  const items = snap.items.filter(p => repo === '' || p.repo === repo)
  const repos = [...new Set(snap.items.map(p => p.repo))].sort()
  const count = (f: PrFilter) => shown(items, f, '', c.now).length
  const act = count('act')
  const next = filter === 'all' || filter === 'act' ? nextUp(items, c.now) : null
  const list = shown(items, filter, '', c.now).filter(p => p !== next)
  const isOwn = (p: PrItem) => p.group === 'need' || p.group === 'ready'
  const headline = act === 0 ? 'Nothing needs you' : `${act} PR${act > 1 ? 's' : ''} need${act > 1 ? '' : 's'} you`
  return (
    <Box flexDirection="column" gap="xs" marginTop="sm">
      <Box flexDirection="row" gap="sm" alignItems="center">
        <Box flexGrow={1}><Text size="title" weight="semibold">{headline}</Text></Box>
        {isFetching ? Spinner(c, 'Refreshing') : <Button key="refresh" plain dimColor label="Refresh" onPress={() => c.act.refresh()} />}
      </Box>
      <Text size="footnote" dimColor>{`${snap.items.length} open in ${repos.length} repo${repos.length === 1 ? '' : 's'} · ${ago(snap.at, c.now)}`}</Text>
      {snap.error && <Text color="error" size="footnote" wrap="wrap">{`Could not update: ${snap.error}`}</Text>}
      <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center" marginTop="sm">
        {FILTERS.filter(f => f.id === 'all' || f.id === filter || count(f.id) > 0).map(f => (
          <Button key={`filter-${f.id}`} variant={f.id === filter ? 'primary' : 'secondary'} label={`${f.label} · ${count(f.id)}`} onPress={() => c.act.filter(f.id)} />
        ))}
      </Box>
      {Select && repos.length > 1 && (
        <Box flexDirection="row" marginTop="xs">
          <Select key="repo" label="Repo" value={repo}
            options={[{ value: '', label: 'All repos' }, ...repos.map(r => ({ value: r, label: repoLabel(c.config, r) }))]}
            onSelect={value => c.act.repo(value)} />
        </Box>
      )}
      {next && NextUp(c, next)}
      {filter === 'all'
        ? FILTERS.filter(f => f.id !== 'all').map(f => {
          const rows = list.filter(p => f.of.includes(p.group))
          return rows.length ? Section(c, `grp-${f.id}`, f.id === 'act' ? 'Also needs you' : f.label, rows.length, rows.map(p => (isOwn(p) ? PrCard(c, p) : PrRow(c, p)))) : null
        })
        : <Box flexDirection="column" gap="sm" marginTop="md">{list.map(p => (isOwn(p) ? PrCard(c, p) : PrRow(c, p)))}</Box>}
      {!next && list.length === 0 && !snap.error && (
        <Box marginTop="md"><Text dimColor>{snap.items.length ? 'Nothing here.' : 'No open pull requests.'}</Text></Box>
      )}
    </Box>
  )
}

function NoPlan(c: Ctx) {
  const { Box, Text, Button } = c.ui
  return (
    <Box flexDirection="column" gap="sm" marginTop="md">
      <Text size="title" weight="semibold">No active chantier</Text>
      <Text wrap="wrap" dimColor>Type /chantier followed by your epic's key. Claude reads the tickets and the code, then proposes a breakdown per repo and wave here, for you to approve before anything starts.</Text>
      <Box flexDirection="row"><Button key="start-plan" variant="primary" label="Plan a chantier" onPress={() => c.act.fill('/chantier ')} /></Box>
    </Box>
  )
}

function briqueMeta(plan: Plan, b: Brique): string {
  const waits = waitsOn(plan, b)
  return [b.id, b.ticket ?? '', b.executor === 'you' ? 'your decision' : b.executor, waits.length ? `waits on ${waits.join(', ')}` : ''].filter(Boolean).join(' · ')
}

function BriqueCard(c: Ctx, plan: Plan, b: Brique, extra: RenderChildren = null) {
  const { Text } = c.ui
  const accent: ThemeKey | null = b.status === 'waiting' ? 'warning' : b.status === 'blocked' ? 'diffRemoved' : null
  return Card(c, `b-${b.id}`, accent, [
    <Text weight="medium" wrap="wrap">{b.title}</Text>,
    <Text size="footnote" dimColor>{briqueMeta(plan, b)}</Text>,
    Pills(c, [STATUS_PILL[b.status]]),
    b.note ? <Text size="footnote" wrap="wrap">{b.note}</Text> : null,
    extra,
  ])
}

function PlanView(c: Ctx, plan: Plan | null) {
  const { Box, Text, Button } = c.ui
  if (!plan) return NoPlan(c)
  const waves = [...new Set(plan.briques.map(b => b.wave))].sort((a, b) => a - b)
  const wave = currentWave(plan)
  const go = goPrompt(plan)
  return (
    <Box flexDirection="column" gap="xs" marginTop="sm">
      <Text size="title" weight="semibold" wrap="wrap">{plan.title}</Text>
      <Text size="footnote" dimColor>{`${plan.epic} · ${plan.briques.length} briques · ${lanes(plan).length} lanes · ${wave === null ? 'all done' : `current wave ${wave}`}`}</Text>
      <Box flexDirection="row" gap="sm" marginTop="sm" flexWrap="wrap">
        {go && <Button key="go" variant="primary" label={`Start wave ${wave}`} onPress={() => c.act.fill(go)} />}
        <Button key="edit-plan" variant="secondary" label="Change the plan" onPress={() => c.act.fill(`Change the plan of chantier ${plan.epic}: `)} />
      </Box>
      {waves.map(w => {
        const inWave = plan.briques.filter(b => b.wave === w)
        const parallel = inWave.filter(b => b.executor === 'session' && !isDone(b)).length
        const summary = inWave.every(isDone) ? 'done' : parallel > 1 ? `${parallel} sessions in parallel` : `${inWave.length} brique${inWave.length > 1 ? 's' : ''}`
        return Section(c, `wave-${w}`, `Wave ${w}`, null, [
          <Text size="footnote" dimColor>{summary}</Text>,
          ...lanes(plan).filter(l => inWave.some(b => b.lane === l)).map(l => (
            <Box key={`lane-${w}-${l}`} flexDirection="column" gap="xs">
              <Text size="footnote" weight="semibold" color={l === YOU_LANE ? 'warning' : 'subtle'}>{l}</Text>
              {inWave.filter(b => b.lane === l).map(b => BriqueCard(c, plan, b))}
            </Box>
          )),
        ])
      })}
    </Box>
  )
}

function prOf(snap: PrSnapshot | null, b: Brique): PrItem | undefined {
  return snap?.items.find(p => (b.pr && p.repo === b.pr.repo && p.number === b.pr.number) || (b.branch !== undefined && p.branch === b.branch))
}

function RunView(c: Ctx, plan: Plan | null, snap: PrSnapshot | null) {
  const { Box, Text, Button } = c.ui
  if (!plan) return NoPlan(c)
  const waiting = plan.briques.filter(b => b.status === 'waiting')
  const running = plan.briques.filter(b => b.status === 'running')
  const blocked = plan.briques.filter(b => !isDone(b) && b.status !== 'running' && waitsOn(plan, b).length > 0)
  return (
    <Box flexDirection="column" gap="xs">
      {Section(c, 'waiting', 'Waiting on you', waiting.length, waiting.length ? waiting.map(b => Card(c, `ask-${b.id}`, 'warning', [
        <Text size="footnote" dimColor>{`${b.id} · ${b.lane}`}</Text>,
        <Text weight="medium" wrap="wrap">{b.question ?? b.note ?? 'No question text'}</Text>,
        <Box flexDirection="row" marginTop="xs"><Button key={`ask-open-${b.id}`} variant="secondary" label="Open its session" onPress={() => c.act.fill(`Open the session of brique ${b.id} of chantier ${plan.epic}${b.worktree ? ` (worktree ${b.worktree})` : ''}.`)} /></Box>,
      ])) : [<Text size="footnote" dimColor>No open question.</Text>])}
      {Section(c, 'repos', 'Per repo', null, lanes(plan).map(l => (
        <Box key={`strip-${l}`} flexDirection="column" gap="xs">
          <Text size="footnote" weight="semibold" color="subtle">{l}</Text>
          {Pills(c, plan.briques.filter(b => b.lane === l).map(b => ({ ...STATUS_PILL[b.status], text: `${b.id} ${STATUS_PILL[b.status].text.toLowerCase()}` })))}
        </Box>
      )))}
      {running.length > 0 && Section(c, 'running', 'Running', running.length, running.map(b => {
        const pr = prOf(snap, b)
        return BriqueCard(c, plan, b, pr ? Pills(c, prPills(pr, c.now)) : null)
      }))}
      {blocked.length > 0 && Section(c, 'blocked', 'Blocked', blocked.length, blocked.map(b => <Text size="footnote" dimColor wrap="wrap">{`${b.id} · ${b.title} · waits on ${waitsOn(plan, b).join(', ')}`}</Text>))}
    </Box>
  )
}

function LandView(c: Ctx, plan: Plan | null, snap: PrSnapshot | null) {
  const { Box, Text, Button, Link } = c.ui
  const backports = (snap?.items ?? []).filter(p => p.backportOf !== null)
  const bySource = new Map<number, PrItem[]>()
  for (const p of backports) bySource.set(p.backportOf as number, [...(bySource.get(p.backportOf as number) ?? []), p])
  const order = plan ? mergeOrder(plan) : []
  const trees = plan?.briques.filter(b => b.worktree) ?? []
  return (
    <Box flexDirection="column" gap="xs">
      {plan ? Section(c, 'order', 'Merge order', order.length, [
        ...order.map((b, i) => {
          const pr = prOf(snap, b)
          return Card(c, `land-${b.id}`, null, [
            <Text weight="medium" wrap="wrap">{`${i + 1}. ${b.title}`}</Text>,
            <Text size="footnote" dimColor>{briqueMeta(plan, b)}</Text>,
            Pills(c, pr ? prPills(pr, c.now) : [isDone(b) ? { text: 'Merged', tone: 'purple', glyph: 'check' } : { text: 'No pull request yet', tone: 'grey', glyph: 'dot' }]),
            pr ? <Box flexDirection="row"><Link href={pr.url} label={`#${pr.number}`} /></Box> : null,
          ])
        }),
        <Box flexDirection="row" marginTop="xs"><Button key="tickets" variant="secondary" label="Prepare the ticket transitions" onPress={() => c.act.fill(`Prepare the ticket transitions of chantier ${plan.epic}: for each brique, the status its ticket should have given its PR. Transition nothing without my go-ahead.`)} /></Box>,
      ]) : NoPlan(c)}
      {Section(c, 'backports', 'Open backports', backports.length, backports.length ? [...bySource.entries()].map(([source, list]) => Card(c, `bp-${source}`, list.some(p => p.isConflict || p.checks.fail) ? 'diffRemoved' : null, [
        <Text weight="medium">{`Backports of #${source}`}</Text>,
        <Text size="footnote" dimColor>{repoLabel(c.config, list[0]?.repo ?? '')}</Text>,
        ...list.map(p => (
          <Box key={`bpr-${p.number}`} flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
            <Link href={p.url} label={`#${p.number}`} />
            {Pills(c, prPills(p, c.now))}
          </Box>
        )),
      ])) : [<Text size="footnote" dimColor>No open Mergify backport.</Text>])}
      {plan && trees.length > 0 && Section(c, 'trees', 'Chantier worktrees', trees.length, trees.map(b => <Text size="footnote" dimColor wrap="wrap">{`${b.id} · ${b.worktree}${isDone(b) ? ' · ready to clean' : ''}`}</Text>))}
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
      await refreshStatus($)
      await refreshPrs($, config)
    })()
    $.clock.every(PR_POLL_MS, () => void refreshPrs($, config).then(() => loadPlan($, config)).then(() => refreshStatus($)))
    $.clock.every(HERE_POLL_MS, () => void refreshHere($).then(() => refreshStatus($)))
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
    return { result: `${b.id}: ${STATUS_PILL[b.status].text.toLowerCase()}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const plan = await read($, planA)
    if (!plan) return composed
    const text = `Active chantier: ${plan.epic} (${plan.briques.length} briques, plan in ~/${config.planDir}/${plan.epic}.json, shown in the Chantier pane). When a linked session reports back or a brique changes state, update it with brique_update. A question for the person: status waiting with the question.`
    return { sections: [...composed.sections, { id: 'chantier', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const ui: UI = {
      ...table,
      Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined,
      Select: 'Select' in table ? table.Select : undefined,
    }
    const now = await $.clock.now()
    // A cell is about 7.5 CSS pixels on the surfaces that draw SVG; a card's padding takes the rest.
    const act: Acts = {
      fill: text => void fill($, text),
      view: v => void update($, viewA, () => v),
      filter: f => void update($, filterA, () => f),
      repo: r => void update($, repoA, () => r),
      refresh: () => void refreshPrs($, config, true),
      goTo: session => void goToSession($, session),
    }
    const c: Ctx = { ui, config, now, act, px: Math.max(160, Math.min(560, Math.floor((e.props.bodyColumns - 8) * 7.5))) }
    const view = await read($, viewA)
    // Before this session's first refresh lands, draw the snapshot another session already shared.
    const snap = (await read($, prsA)) ?? ((await $.store.get('prs')) as PrSnapshot | undefined) ?? null
    const lock = (await $.store.get('prsLock')) as number | undefined
    const plan = await read($, planA)
    const waiting = snap?.items.filter(p => p.group === 'need' || p.group === 'ready').length ?? 0
    const { Box } = ui
    return (
      <Box flexDirection="column" gap="sm" paddingX="sm" paddingY="sm">
        {Switcher(c, view, waiting)}
        {view === 'pr' && PrView(c, snap, await read($, filterA), await read($, repoA), lock !== undefined && now - lock < 90_000)}
        {view === 'plan' && PlanView(c, plan)}
        {view === 'run' && RunView(c, plan, snap)}
        {view === 'land' && LandView(c, plan, snap)}
      </Box>
    )
  })
}
