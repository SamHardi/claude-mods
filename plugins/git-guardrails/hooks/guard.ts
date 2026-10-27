// git-guardrails: pure checks over a Bash command line. Each returns why the command is refused, or null.
// They read the command text only; the facts that need the machine (current branch, other live sessions) come in `ctx`.
// Pure on purpose: tests/guard.test.ts drives them through the engine's own tool.call.

import { FEATURE_BASE } from './config'

export type GuardContext = {
  /** Branches nobody pushes to directly. */
  protectedBranches: readonly string[]
  /** `docker compose up` under a folder matching `dir` needs `variable` in the command line; null turns the rule off. */
  composeEnv: { dir: string; variable: string } | null
  /** The branch checked out where the command runs, when it touches git. */
  branch: string | null
  /** The working directory the command runs in (after a leading `cd`). */
  dir: string
  /** Another live Claude session works in the same checkout. */
  sharedCheckoutWith: string | null
}

const ATTRIBUTION = [/co-authored-by:\s*claude/i, /generated with \[?claude code/i, /🤖/u]
const BANG_SUBJECT = /^[a-z]+(\([^)]*\))?!:/
const SUBJECT_MAX = 72

/** Splits a command line on `&&`, `||`, `;` and `|`, outside quotes, keeping heredoc bodies with their command. */
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      if (c === quote && command[i - 1] !== '\\') quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (c === ';' || c === '\n' || (c === '|' && command[i + 1] !== '|')) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Shell-like tokens of one segment: quotes removed, `$(...)` kept whole. */
export function tokens(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string
    if (depth > 0) {
      if (c === '(') depth++
      if (c === ')') depth--
      cur += c
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      else if (c === '$' && segment[i + 1] === '(') {
        depth = 1
        cur += '$('
        i++
      } else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '$' && segment[i + 1] === '(') {
      depth = 1
      cur += '$('
      i++
      continue
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** The directory a command runs in: the last leading `cd <dir>` before git, else the session's. */
export function commandDir(command: string, sessionDir: string, home: string): string {
  let dir = sessionDir
  for (const seg of segments(command)) {
    const t = tokens(seg)
    if (t[0] !== 'cd' || !t[1]) break
    const target = t[1].replace(/^~(?=\/|$)/, home)
    dir = target.startsWith('/') ? target : `${dir.replace(/\/$/, '')}/${target}`
  }
  return dir
}

/** The git subcommand and its arguments of a segment, skipping `git -C <dir>` and `-c k=v`. */
function gitCall(t: string[]): { sub: string; args: string[]; cdir: string | null } | null {
  const at = t.indexOf('git')
  if (at === -1 || (at > 0 && !/^[A-Z_]+=/.test(t[at - 1] ?? ''))) return null
  let i = at + 1
  let cdir: string | null = null
  while (i < t.length && (t[i] ?? '').startsWith('-')) {
    if (t[i] === '-C') cdir = t[i + 1] ?? null
    i += t[i] === '-C' || t[i] === '-c' ? 2 : 1
  }
  const sub = t[i]
  return sub ? { sub, args: t.slice(i + 1), cdir } : null
}

export function needsBranch(command: string): boolean {
  return /\bgit\b[^;&|]*\b(push|checkout|switch)\b/.test(command)
}

export function gitDirOf(command: string): string | null {
  for (const seg of segments(command)) {
    const call = gitCall(tokens(seg))
    if (call?.cdir) return call.cdir
  }
  return null
}

function checkPush(args: string[], branch: string | null, protectedBranches: readonly string[]): string | null {
  const positional = args.filter(a => !a.startsWith('-'))
  const refspecs = positional.slice(1)
  const targets = refspecs.length === 0 ? [branch ?? ''] : refspecs.map(r => {
    const dest = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r
    const name = dest.replace(/^\+/, '').replace(/^refs\/heads\//, '')
    return name === 'HEAD' ? branch ?? '' : name
  })
  const hit = targets.find(t => protectedBranches.includes(t))
  return hit
    ? `no direct push to \`${hit}\`. Push a feature branch and open a pull request.`
    : null
}

function checkSwitch(sub: string, args: string[], ctx: GuardContext): string | null {
  if (!ctx.sharedCheckoutWith) return null
  const switches = sub === 'switch'
    || (sub === 'checkout' && (args.some(a => a === '-b' || a === '-B' || a === '--orphan')
      || (!args.includes('--') && args.length === 1 && /^[\w.-]+(\/[\w.-]+)*$/.test(args[0] ?? '') && !/\.\w{1,5}$/.test(args[0] ?? ''))))
  return switches
    ? `the session "${ctx.sharedCheckoutWith}" already works in this checkout. One task, one worktree: create one with \`git worktree add\` instead of switching branches here.`
    : null
}

/** The commit message given with -m/--message, heredoc bodies included. */
export function commitMessage(args: string[]): string | null {
  const parts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    let value: string | undefined
    if (a === '-m' || a === '--message') value = args[++i]
    else if (a.startsWith('--message=')) value = a.slice('--message='.length)
    else if (/^-[a-zA-Z]*m$/.test(a)) value = args[++i]
    if (value !== undefined) parts.push(unwrapHeredoc(value))
  }
  return parts.length ? parts.join('\n\n') : null
}

function unwrapHeredoc(value: string): string {
  const m = /^\$\(cat <<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)$/.exec(value.trim())
  return m ? (m[2] as string) : value
}

function checkCommit(args: string[]): string | null {
  const message = commitMessage(args)
  if (message === null) return null
  const subject = (message.trim().split('\n')[0] ?? '').trim()
  if (BANG_SUBJECT.test(subject)) {
    return 'no `!` in the subject: semantic-release with the angular preset does not read it. Put a `BREAKING CHANGE:` footer below `Closes`/`Refs` instead.'
  }
  if (subject.length > SUBJECT_MAX) {
    return `commit subject of ${subject.length} characters: ${SUBJECT_MAX} at most.`
  }
  return null
}

function flagValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === flag) return args[i + 1] ?? null
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return null
}

function checkGhPr(t: string[]): string | null {
  const at = t.indexOf('gh')
  if (at === -1 || t[at + 1] !== 'pr') return null
  const verb = t[at + 2]
  const args = t.slice(at + 3)
  if (verb !== 'create' && verb !== 'edit') return null
  const base = flagValue(args, '--base') ?? flagValue(args, '-B')
  if (base && FEATURE_BASE.test(base)) {
    return `base \`${base}\`: a PR based on a feature branch lands in that branch, not in the real target, once merged. Keep the real target and use a stacked PR.`
  }
  const title = flagValue(args, '--title') ?? flagValue(args, '-t')
  if (title && BANG_SUBJECT.test(title)) {
    return 'no `!` in the PR title: the `BREAKING CHANGE:` footer carries the break.'
  }
  return null
}

function checkCompose(segment: string, command: string, ctx: GuardContext): string | null {
  const rule = ctx.composeEnv
  if (!rule || !/\bdocker[ -]compose\b[^;&|]*\bup\b/.test(segment)) return null
  const inScope = ctx.dir.includes(rule.dir) || segment.includes(rule.dir)
  if (!inScope || command.includes(rule.variable)) return null
  return `\`docker compose up\` under ${rule.dir} without \`${rule.variable}\`: a non-interactive shell does not read your shell profile, so the stack would start without it. Export it in the same command first.`
}

function checkAttribution(command: string): string | null {
  if (!/\b(git commit|gh (pr|issue) (create|edit|comment|review)|gh api)\b/.test(command)) return null
  return ATTRIBUTION.some(re => re.test(command))
    ? 'no AI attribution (Co-Authored-By Claude, "Generated with Claude Code", 🤖) in commits, PRs or comments.'
    : null
}

/** Every rule over the whole command line: the first refusal, or null. */
export function checkCommand(command: string, ctx: GuardContext): string | null {
  const attribution = checkAttribution(command)
  if (attribution) return attribution
  for (const seg of segments(command)) {
    const t = tokens(seg)
    const compose = checkCompose(seg, command, ctx)
    if (compose) return compose
    const gh = checkGhPr(t)
    if (gh) return gh
    const call = gitCall(t)
    if (!call) continue
    const reason = call.sub === 'push' ? checkPush(call.args, ctx.branch, ctx.protectedBranches)
      : call.sub === 'commit' ? checkCommit(call.args)
      : call.sub === 'checkout' || call.sub === 'switch' ? checkSwitch(call.sub, call.args, ctx)
      : null
    if (reason) return reason
  }
  return null
}
