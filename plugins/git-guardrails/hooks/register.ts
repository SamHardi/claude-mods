import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { GIT_BINS, HEARTBEAT_MS, SESSIONS_DIR, SESSION_LIVE_MS, rulesOf } from './config'
import { checkCommand, commandDir, gitDirOf, needsBranch } from './guard'

type $ = EngineInterface
type Heartbeat = { id: string; label: string; toplevel: string | null; at: number; ended: boolean }

const allowOnce = atom({ plugin: 'git-guardrails', key: 'allowOnce' } as const, false)

let home: string | null = null
let gitBin: string | null = null

async function homeOf($: $): Promise<string> {
  if (!home) home = (await $.env.get('HOME')) ?? ''
  return home
}

async function git($: $, dir: string, ...args: string[]): Promise<string | null> {
  if (!gitBin) {
    gitBin = 'git'
    for (const path of GIT_BINS) {
      if (await $.fs.exists(path)) {
        gitBin = path
        break
      }
    }
  }
  try {
    const { exitCode, stdout } = await $.process.run([gitBin, '-C', dir, ...args], { timeoutMs: 10_000 })
    return exitCode === 0 ? stdout.trim() : null
  } catch (err) {
    $.ui.log(`git-guardrails: git ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return null
  }
}

const sessionsDir = async ($: $) => `${await homeOf($)}/${SESSIONS_DIR}`

/** Tells the other sessions which checkout this one works in. */
async function heartbeat($: $, ended = false): Promise<void> {
  const cwd = await $.session.cwd()
  const toplevel = await git($, cwd, 'rev-parse', '--show-toplevel')
  const branch = toplevel ? await git($, cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null
  const id = await $.session.id()
  const beat: Heartbeat = { id, label: branch ?? toplevel?.split('/').pop() ?? id.slice(0, 8), toplevel, at: await $.clock.now(), ended }
  await $.fs.write(`${await sessionsDir($)}/${id}.json`, JSON.stringify(beat))
}

/** Another live session working in the same checkout, by its label. */
async function sharedCheckout($: $, toplevel: string): Promise<string | null> {
  const dir = await sessionsDir($)
  if (!(await $.fs.exists(dir))) return null
  const me = await $.session.id()
  const now = await $.clock.now()
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json') || entry.name === `${me}.json`) continue
    try {
      const other = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Heartbeat
      if (!other.ended && now - other.at < SESSION_LIVE_MS && other.toplevel === toplevel) return other.label
    } catch (err) {
      $.ui.log(`git-guardrails: unreadable heartbeat ${entry.name}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
  }
  return null
}

export const register: Register = (on, options) => {
  const rules = rulesOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'guardrails',
      description: 'git-guardrails: let the next refused command through, once',
      argumentHint: 'allow',
    })
    void heartbeat($)
    $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
    return started
  })

  on('session.end', async ($, e, next) => {
    await heartbeat($, true).catch(err => $.ui.log(`git-guardrails: last heartbeat failed: ${String(err)}`, { to: 'debug' }))
    return next(e)
  })

  on('command.run', { command: 'guardrails' }, async ($, e) => {
    if (e.args.trim() !== 'allow') return { text: 'Usage: /guardrails allow' }
    await update($, allowOnce, () => true)
    return { text: 'git-guardrails: the next refused command will run, once.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command
    const base = commandDir(command, await $.session.cwd(), await homeOf($))
    const gdir = gitDirOf(command)
    const dir = gdir ? (gdir.startsWith('/') ? gdir : `${base}/${gdir}`) : base
    let branch: string | null = null
    let shared: string | null = null
    if (needsBranch(command)) {
      branch = await git($, dir, 'rev-parse', '--abbrev-ref', 'HEAD')
      const top = await git($, dir, 'rev-parse', '--show-toplevel')
      shared = top ? await sharedCheckout($, top) : null
    }
    const reason = checkCommand(command, { ...rules, branch, dir, sharedCheckoutWith: shared })
    if (!reason) return next(e)
    if (await read($, allowOnce)) {
      await update($, allowOnce, () => false)
      $.ui.toast(`git-guardrails: let through once (${reason.slice(0, 80)})`)
      return next(e)
    }
    return { deny: `git-guardrails: ${reason} If this is intended, the person can type /guardrails allow to let it through once.` }
  }).catch(($, e, next) => {
    // A broken guard must not stop every Bash call: GitHub's branch protection stays the hard barrier.
    $.ui.log('git-guardrails: the guard failed, the command runs unchecked', { to: 'debug' })
    return next(e)
  })
}
