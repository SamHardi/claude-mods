import { expect, test } from 'claude-code/testing'

import { changes, checksOf, groupOf, ticketOf } from '../hooks/prs'
import { mergeOrder, unblocks, validatePlan, waitsOn } from '../hooks/plan'
import type { Plan, PrItem } from '../types'

const NOW = Date.parse('2026-10-27T15:00:00Z')

const pr = (over: Partial<PrItem>): PrItem => ({
  repo: 'acme-ui', number: 134, title: 't', url: 'https://example.test/pr/134', branch: 'feat/PROJ-165-x',
  isDraft: false, updatedAt: '2026-10-26T10:00:00Z', review: 'REVIEW_REQUIRED', isConflict: false,
  checks: { ok: 6, fail: 0, pending: 0 }, ticket: 'PROJ-165', group: 'review', worktree: null, backportOf: null, base: 'main', ...over,
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
    expect((await ui.find({ type: 'Text', text: /PROJ-157/ }))?.text).toContain('One permission model')
    expect(await ui.find({ type: 'Text', text: /^Wave 2$/ })).toBeDefined()
    await ui.unmount()
  }
})
