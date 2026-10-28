import { expect, test } from 'claude-code/testing'

import { changes, checksOf, groupOf, isCiStuck, parseSessions, sessionFor, ticketOf } from '../hooks/prs'
import { mergeOrder, unblocks, validatePlan, waitsOn } from '../hooks/plan'
import { pillsSvg, textWidth } from '../hooks/pills'
import { actionOf, nextUp, prPills, routed, shown } from '../hooks/triage'
import type { Plan, PrItem } from '../types'

const NOW = Date.parse('2026-10-27T15:00:00Z')

const pr = (over: Partial<PrItem>): PrItem => ({
  repo: 'acme-ui', number: 134, title: 't', url: 'https://example.test/pr/134', branch: 'feat/PROJ-165-x',
  isDraft: false, updatedAt: '2026-10-26T10:00:00Z', review: 'REVIEW_REQUIRED', isConflict: false,
  checks: { ok: 6, fail: 0, pending: 0 }, ticket: 'PROJ-165', group: 'review', worktree: null, backportOf: null, base: 'main', session: null, ...over,
})

const PLAN = {
  epic: 'PROJ-157', title: 'One permission model',
  briques: [
    { id: 'B1', title: 'Backend model', repo: 'acme-api', lane: 'API', wave: 0, executor: 'session' },
    { id: 'D1', title: 'Scope parameter', repo: '-', lane: 'You', wave: 1, executor: 'you' },
    { id: 'B3', title: 'Scope in filters', repo: 'acme-ui', lane: 'UI', wave: 1, executor: 'session', dependsOn: ['D1', 'B1'] },
    { id: 'B5', title: 'Bump in the app', repo: 'acme-app', lane: 'App', wave: 2, executor: 'session', dependsOn: ['B3'] },
  ],
}

test('a PR is grouped by what it waits for', () => {
  expect(groupOf(pr({ isConflict: true }), NOW, 30)).toBe('need')
  expect(groupOf(pr({ checks: { ok: 4, fail: 2, pending: 0 } }), NOW, 30)).toBe('need')
  expect(groupOf(pr({ review: 'APPROVED' }), NOW, 30)).toBe('ready')
  expect(groupOf(pr({ review: 'APPROVED', checks: { ok: 3, fail: 0, pending: 3 } }), NOW, 30)).toBe('review')
  expect(groupOf(pr({ isDraft: true, isConflict: true }), NOW, 30)).toBe('draft')
  expect(groupOf(pr({ updatedAt: '2026-05-23T10:00:00Z' }), NOW, 30)).toBe('stale')
  expect(groupOf(pr({ updatedAt: '2026-05-23T10:00:00Z', isConflict: true }), NOW, 30)).toBe('stale')
})

test('checks, tickets and changes read gh the way it answers', () => {
  expect(checksOf([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }, { state: 'PENDING' }, { conclusion: 'NEUTRAL' }]))
    .toEqual({ ok: 2, fail: 1, pending: 2 })
  expect(ticketOf('mergify/bp/4.12.x/pr-21834', 'backport of SUP-14493 fix')).toBe('SUP-14493')
  expect(ticketOf('feat/proj-170-consistent-failure-states')).toBe('PROJ-170')
  const before = [pr({ checks: { ok: 3, fail: 0, pending: 3 } }), pr({ number: 135 })]
  const after = [pr({ isConflict: true, review: 'APPROVED' })]
  expect(changes(before, after)).toEqual([
    'CI green · acme-ui#134',
    'PR approved · acme-ui#134',
    'Conflict · acme-ui#134',
    'PR closed or merged · acme-ui#135',
  ])
})

test('a PR finds its session by branch, then worktree, then ticket in the title', () => {
  const sessions = parseSessions({ content: [{ type: 'text', text: JSON.stringify([
    { sessionId: 'local_a', title: 'PROJ-165 | Workspace scope', branch: 'claude/other', link: 'claude://a' },
    { sessionId: 'local_b', title: 'Something else', branch: 'feat/PROJ-170-x', link: 'claude://b' },
    { sessionId: 'local_d', title: 'Source fix', prNumber: 21834 },
    { sessionId: 'local_c', title: 'SUP-14493 | Investigation', isArchived: true },
  ]) }] })
  expect(sessions.length).toBe(4)
  expect(sessionFor(pr({ number: 21845, branch: 'mergify/bp/4.12.x/pr-21834', backportOf: 21834, ticket: null }), sessions)?.id).toBe('local_d')
  expect(sessionFor(pr({ branch: 'feat/PROJ-170-x', ticket: 'PROJ-170' }), sessions)?.id).toBe('local_b')
  expect(sessionFor(pr({ branch: 'mergify/bp/4.12.x/pr-1', ticket: 'PROJ-165' }), sessions)?.link).toBe('claude://a')
  expect(sessionFor(pr({ branch: 'x', ticket: 'SUP-14493' }), sessions)).toBeNull()
  expect(parseSessions('not json')).toEqual([])
})

test('checks pending a day after the last move are stuck', () => {
  expect(isCiStuck(pr({ checks: { ok: 11, fail: 0, pending: 1 }, updatedAt: '2026-05-26T10:00:00Z' }), NOW)).toBe(true)
  expect(isCiStuck(pr({ checks: { ok: 3, fail: 0, pending: 3 }, updatedAt: '2026-10-27T14:00:00Z' }), NOW)).toBe(false)
})

test('a plan is refused with every reason, and a cycle is caught', () => {
  const bad = validatePlan({ epic: 'nope', title: '', briques: [{ id: 'B1', title: 'x', repo: 'r', lane: 'r', wave: -1, executor: 'robot' }] }, 'now')
  expect('errors' in bad && bad.errors.length).toBe(3)
  const cyclic = validatePlan({ epic: 'PROJ-1', title: 't', briques: [
    { id: 'A', title: 'a', repo: 'r', lane: 'r', wave: 1, executor: 'session', dependsOn: ['B'] },
    { id: 'B', title: 'b', repo: 'r', lane: 'r', wave: 1, executor: 'session', dependsOn: ['A'] },
  ] }, 'now')
  expect('errors' in cyclic && cyclic.errors[0]).toContain('circular')
})

test('a valid plan gives dependencies, unblocking and a landing order', () => {
  const checked = validatePlan(PLAN, 'now')
  if (!('plan' in checked)) throw new Error(checked.errors.join('; '))
  const plan: Plan = checked.plan
  const b3 = plan.briques.find(b => b.id === 'B3')
  expect(plan.briques.find(b => b.id === 'B1')?.status).toBe('done')
  expect(b3 && waitsOn(plan, b3)).toEqual(['D1'])
  expect(unblocks(plan, 'B3')).toEqual(['B5'])
  expect(mergeOrder(plan).map(b => b.id)).toEqual(['B1', 'B3', 'B5'])
})

test('the plan view draws the waves on every surface', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('clock.now', () => ({ value: NOW }))
  const store = new Map<string, unknown>()
  on('store.set', (_, e) => { const { key, value } = e as { key: string; value: unknown }; store.set(key, value); return { value: undefined } })
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  await $.tool.call({ tool: 'mcp__chantier__plan_write', ...PLAN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chantier', component: 'Pane', requestId: 'chantier', surface,
      props: { title: 'Chantier', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^One permission model$/ }))?.text).toBe('One permission model')
    expect((await ui.find({ type: 'Text', text: /^PROJ-157 · 4 briques/ }))?.text).toContain('current wave 1')
    expect(await ui.find({ type: 'Text', text: /^Wave 2$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the most urgent PR comes next, and its job goes to the session working on it', () => {
  const conflict = pr({ number: 1, isConflict: true, group: 'need', updatedAt: '2026-10-25T10:00:00Z' })
  const failing = pr({ number: 2, checks: { ok: 4, fail: 2, pending: 0 }, group: 'need', updatedAt: '2026-10-20T10:00:00Z' })
  const ready = pr({ number: 3, review: 'APPROVED', group: 'ready' })
  const waiting = pr({ number: 4 })
  expect(nextUp([waiting, ready, failing, conflict], NOW)?.number).toBe(1)
  expect(nextUp([waiting, ready, failing], NOW)?.number).toBe(2)
  expect(nextUp([waiting], NOW)).toBeNull()
  expect(shown([waiting, ready, failing, conflict], 'act', '', NOW).map(p => p.number)).toEqual([1, 2, 3])
  expect(actionOf(failing, NOW)?.label).toBe('Triage CI')
  expect(actionOf(pr({ isConflict: true, backportOf: 21834, base: '4.12.x' }), NOW)?.task).toContain('to 4.12.x')
  expect(actionOf(waiting, NOW)).toBeNull()
  const session = { id: 'local_a', title: 'PROJ-165 | Scope', link: null }
  expect(routed(pr({ session }), 'Do it.')).toContain('Send this to session local_a ("PROJ-165 | Scope")')
  expect(routed(pr({ worktree: '/w/acme-ui-165' }), 'Do it.')).toContain('Start a session in /w/acme-ui-165')
})

test('pills say the state in words and wrap within the room given', () => {
  const pills = prPills(pr({ checks: { ok: 3, fail: 0, pending: 1 }, updatedAt: '2026-10-27T14:00:00Z', backportOf: 9, base: '4.12.x', review: 'APPROVED' }), NOW)
  expect(pills.map(p => p.text)).toEqual(['Approved', 'CI 3/4', '4.12.x'])
  expect(pills[1]?.progress).toBe(0.75)
  const one = pillsSvg([{ text: 'Conflict <a>', tone: 'red', glyph: 'cross' }], 400)
  expect(one.source).toContain('Conflict &lt;a&gt;')
  expect(one.source).toContain('prefers-color-scheme:dark')
  expect(one.height).toBe(20)
  const many = pillsSvg(Array.from({ length: 6 }, () => ({ text: 'Changes requested', tone: 'red' as const })), 200)
  expect(many.width <= 200).toBe(true)
  expect(many.height > 20).toBe(true)
  expect(textWidth('mm') > textWidth('ii')).toBe(true)
})

test('the PR view leads with the next PR and draws pills, links and actions', { options: { repoAliases: 'acme-ui=ui' } }, async ($, on) => {
  const snapshot = { at: NOW, error: null, items: [
    pr({ isConflict: true, group: 'need', title: 'Scope the filters', session: { id: 'local_a', title: 'PROJ-165 | Scope', link: 'claude://claude.ai/epitaxy/local_a' } }),
    pr({ number: 135, title: 'Show failures', group: 'review' }),
  ] }
  on('clock.now', () => ({ value: NOW + 1_000 }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'prs' ? snapshot : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.log', () => ({ value: undefined }))
  const runs: string[] = []
  on('process.run', (_, e) => { runs.push(JSON.stringify(e)); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chantier', component: 'Pane', requestId: 'chantier', surface,
      props: { title: 'Chantier', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^1 PR needs you$/ }))?.text).toBe('1 PR needs you')
    expect((await ui.find({ type: 'Text', text: /^Next up$/ }))?.text).toBe('Next up')
    expect((await ui.find({ type: 'Text', text: /^Scope the filters$/ }))?.text).toBe('Scope the filters')
    expect((await ui.find({ type: 'Text', text: /^Conflicts with main\.$/ }))?.text).toBe('Conflicts with main.')
    expect(await ui.find({ type: 'Button', key: 'act-acme-ui-134' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^PROJ-165 \| Scope$/ }))?.text).toBe('PROJ-165 | Scope')
    expect(await ui.find({ type: 'Button', key: 'sess-acme-ui-135' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'copy-acme-ui-134' })).toBeUndefined()
    await ui.press({ key: 'goto-acme-ui-134' })
    expect(runs.at(-1)).toContain('"claude://claude.ai/epitaxy/local_a"')
    expect(await ui.find({ type: 'Button', key: 'filter-review' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    else expect((await ui.find({ type: 'Text', text: /^✕ Conflict$/ }))?.text).toBe('✕ Conflict')
    await ui.unmount()
  }
})

test('/chantier on an epic with no plan asks to catch up and align before planning', async ($, on) => {
  const filled: string[] = []
  on('prompt.fill', (_, e) => { filled.push((e as { text: string }).text); return { isFilled: true } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  const answer = await $.command.run({ command: 'chantier', args: 'proj-9' } as Parameters<typeof $.command.run>[0])
  const prompt = filled.at(-1) ?? ''
  expect(JSON.stringify(answer)).toContain('No plan yet for PROJ-9')
  expect(prompt).toContain('Then wait for my answers')
  expect(prompt.indexOf('Then wait for my answers') < prompt.indexOf('find the repos')).toBe(true)
})
