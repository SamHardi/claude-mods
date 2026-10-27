import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

type Port = { port: number; label: string }

const POLL_MS = 30_000
const LSOF = '/usr/sbin/lsof'

/** `3000:web, 8080:api` → ports to watch. */
export function parsePorts(v: unknown): Port[] {
  return String(v ?? '').split(',').map(s => s.trim()).filter(Boolean).flatMap(entry => {
    const [port, label] = entry.split(':')
    const n = Number(port)
    return Number.isInteger(n) && n > 0 ? [{ port: n, label: label?.trim() || String(n) }] : []
  })
}

async function lsof($: $, args: string[]): Promise<string> {
  try {
    const { stdout } = await $.process.run([LSOF, ...args], { timeoutMs: 5_000 })
    return stdout
  } catch (err) {
    $.ui.log(`dev-loop: lsof ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return ''
  }
}

/** One part per port: up or down, and the desk (folder) of the process that listens. */
export async function portsLine($: $, here: string, ports: Port[]): Promise<string> {
  const parts: string[] = []
  for (const { port, label } of ports) {
    const pid = (await lsof($, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).trim().split('\n')[0]
    if (!pid) {
      parts.push(`${label} :${port} ✗`)
      continue
    }
    const cwd = (await lsof($, ['-a', '-p', pid, '-d', 'cwd', '-Fn'])).split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null
    const desk = !cwd ? '?' : cwd.startsWith(here) ? 'here' : cwd.split('/').pop()
    parts.push(`${label} :${port} ✓ ${desk}`)
  }
  return parts.join(' · ')
}

async function refresh($: $, ports: Port[], roots: string[]): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root()
  if (roots.length && !roots.some(r => root.startsWith(r.startsWith('/') ? r : `${home}/${r}`))) return
  $.ui.status(await portsLine($, root, ports))
}

export const register: Register = (on, options) => {
  const ports = parsePorts(options.ports)
  const roots = String(options.roots ?? '').split(',').map(s => s.trim()).filter(Boolean)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!ports.length) return started
    void refresh($, ports, roots)
    $.clock.every(POLL_MS, () => void refresh($, ports, roots))
    return started
  })
}
