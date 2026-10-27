import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// Nothing sits beneath the plugin: each hook here stands for the engine.
// git answers "master" as the current branch; no other session is alive.
function engine(on: On, branch = 'master') {
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const stdout = argv.includes('--abbrev-ref') ? `${branch}\n` : argv.includes('--show-toplevel') ? '/repo\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('env.get', () => ({ value: '/home/test' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

const refused = async ($: Engine, command: string) => {
  const ran = await $.tool.call({ tool: 'Bash', command })
  return 'deny' in ran && ran.deny !== undefined ? ran.deny : null
}

test('refuses a direct push to a protected branch', async ($, on) => {
  engine(on)
  expect(await refused($, 'git push origin master')).toContain('no direct push')
  expect(await refused($, 'git push')).toContain('no direct push')
  expect(await refused($, 'git push origin HEAD:refs/heads/main')).toContain('no direct push')
  expect(await refused($, 'git push --force-with-lease origin feat/PROJ-1-x')).toBeNull()
})

test('lets a feature branch push through', async ($, on) => {
  engine(on, 'feat/PROJ-1-x')
  expect(await refused($, 'git push -u origin feat/PROJ-1-x')).toBeNull()
  expect(await refused($, 'cd /repo && git push')).toBeNull()
})

test('refuses a PR based on a feature branch, not on a maintenance branch', async ($, on) => {
  engine(on)
  expect(await refused($, 'gh pr edit 21366 --base feat/PROJ-163-lookup')).toContain('stacked PR')
  expect(await refused($, 'gh pr create --base 4.12.x --title "fix(x): y"')).toBeNull()
})

test('holds commit subjects to 72 characters and no bang', async ($, on) => {
  engine(on)
  expect(await refused($, 'git commit -m "feat(x)!: break it"')).toContain('BREAKING CHANGE')
  expect(await refused($, `git commit -m "${'fix(scope): '.padEnd(80, 'a')}"`)).toContain('72 at most')
  const heredoc = "git commit -m \"$(cat <<'EOF'\nfix(dashboards): renumber the other dashboards on reorder\n\nCloses PROJ-162\nEOF\n)\""
  expect(await refused($, heredoc)).toBeNull()
})

test('refuses AI attribution in commits and PRs', async ($, on) => {
  engine(on)
  const commit = "git commit -m \"$(cat <<'EOF'\nfix(x): y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\""
  expect(await refused($, commit)).toContain('no AI attribution')
  expect(await refused($, 'gh pr create --title "fix(x): y" --body "🤖 Generated with Claude Code"')).toContain('no AI attribution')
})

test('the compose rule is off unless configured, and checks the variable when it is', async ($, on) => {
  engine(on)
  expect(await refused($, 'cd docker/quick-setup/mongodb && docker compose up -d')).toBeNull()
})

test('checks the compose variable once configured', { options: { composeEnv: 'quick-setup:STACK_KEY' } }, async ($, on) => {
  engine(on)
  expect(await refused($, 'cd docker/quick-setup/mongodb && docker compose up -d')).toContain('STACK_KEY')
  expect(await refused($, 'export STACK_KEY=$(x) && cd docker/quick-setup/mongodb && docker compose up -d')).toBeNull()
})
