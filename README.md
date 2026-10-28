# claude-mods

Claude Code mods for working on several things at once: many sessions, worktrees, workflows and PRs across repos. Each mod is its own plugin, so you can install, configure or turn off one without the others.

| Mod | What it adds |
| --- | --- |
| [chantier](plugins/chantier) | A pane with four views, a status line entry and relay toasts. |
| [git-guardrails](plugins/git-guardrails) | Refuses risky git, gh and docker commands before they run. |
| [dev-loop](plugins/dev-loop) | A status line saying which dev ports are up and which folder serves each. |

Mods are early access in Claude Code: the API they use may change between releases.

## Install

At the prompt of a terminal session:

```
/plugin install chantier --marketplace SamHardi/claude-mods
/plugin install git-guardrails --marketplace SamHardi/claude-mods
/plugin install dev-loop --marketplace SamHardi/claude-mods
```

From a shell:

```bash
claude plugin install chantier --marketplace SamHardi/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `SamHardi/claude-mods`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. Each mod's options are rows in `/config`, or values under `pluginConfigs.<mod>.options` in `~/.claude/settings.json`.

## chantier

`/chantier` opens a pane beside the chat. It has four views:

- **PRs**: your open PRs, plus the open Mergify backports of your merged ones. The view leads with how many need you and a **Next up** card: the most urgent PR (conflict, then failed checks, changes requested, ready to merge, stuck CI), why, and one button for its job (*Fix the backport*, *Resolve conflicts*, *Triage CI*, *Address review*, *Merge…*, *Check CI*). The button puts a prompt in the input box that hands the job to the session working on the PR, or starts one in its worktree; nothing runs until you send it. Filters (needs you, in review, drafts, stale) and a repo picker narrow the list. PRs that need you are cards; the others are light rows. State reads as pills (CI progress, review, conflict, backport target), drawn as SVG on the desktop app and as coloured words in the terminal. Each PR links to itself and its ticket; *Go to session* shows the session working on it in the desktop app, and *Start a session* prepares one when there is none.
- **Plan**: `/chantier PROJ-157` puts a lead prompt in the input box. Claude first catches up (the epic, its tickets and comments, earlier sessions on it, the canvases they left, open branches and PRs), tells you where it stands (decisions and tickets still valid, to change or obsolete, and the questions only you can answer), and waits until you agree. Only then does it read the code and call the `plan_write` tool the mod gives it. The plan splits the work into briques (1 ticket, 1 repo, 1 branch, 1 PR) laid out per repo (lane) and per wave; everything in one wave runs in parallel. Each brique has an executor: a linked session, a workflow, a subagent, or you. Nothing starts until you approve. `/chantier go` then prepares the launch prompt for the next wave.
- **Run**: what waits on you first, then each repo's briques by state, then what is running and what is blocked. Claude keeps it current with the `brique_update` tool as linked sessions report back.
- **Landing**: the merge order taken from the dependencies, the open backports, and the worktrees to clean up.

A status line entry shows the session's ticket and, in a chantier, its brique, wave and dependencies; the band above the prompt stays the app's own (branch, diff, pull request). Toasts announce CI results, approvals, new conflicts, and the briques a closed PR unblocks.

Plans are JSON files under `~/.claude/chantiers/`, outside your repos. PR data comes from `gh`, which must be installed and signed in.

| Option | Meaning |
| --- | --- |
| `owner` | GitHub org or user the PR search is limited to. Empty searches every repo. |
| `ticketUrl` | Prefix ticket keys are appended to for links, e.g. `https://example.atlassian.net/browse/`. |
| `repoAliases` | `repo=label` pairs for shorter repo names in the pane. |
| `clones` | `repo=path` entries, comma-separated (`|` between several paths), scanned to find each PR's worktree. |
| `backportRepos` | Repos whose Mergify backports of your merged PRs are tracked. |
| `staleDays` | Days without activity before an open PR counts as stale (30). |
| `planDir` | Where plans are saved, relative to your home (`.claude/chantiers`). |

## git-guardrails

It refuses a Bash command before it runs, with the reason, when the command:

- pushes directly to a protected branch (`main`, `master`, `develop` by default);
- bases a PR on a feature branch, which would land the PR in that branch rather than its real target;
- commits with a subject over 72 characters or with `!` (semantic-release's angular preset ignores it; use a `BREAKING CHANGE:` footer);
- adds AI attribution to a commit, PR or comment;
- runs `docker compose up` under a configured folder without a configured variable, when that rule is set;
- switches branches in a checkout another live Claude session works in (sessions announce their checkout through heartbeats under `~/.claude/chantiers/sessions/`).

`/guardrails allow` lets the next refused command through, once. If the guard itself fails, the command runs unchecked: keep branch protection on your remote as the hard barrier.

| Option | Meaning |
| --- | --- |
| `protectedBranches` | Comma-separated branches nobody pushes to directly. |
| `composeEnv` | `dir:VARIABLE`: `docker compose up` under a path containing `dir` needs `VARIABLE` in the command. Empty turns the rule off. |

## dev-loop

It shows each watched port as up or down, with the folder of the process listening on it: `here` for this session's checkout, or the name of another desk or worktree. Use it when several sessions share one dev server.

| Option | Meaning |
| --- | --- |
| `ports` | `port:label` pairs, e.g. `3000:web,8080:api`. Empty shows nothing. |
| `roots` | Folders whose sessions show the line. Empty shows it everywhere. |

## Develop

Each plugin type-checks with the `tsconfig.json` the engine lays in its `.claude-plugin/types/` once loaded, and tests with:

```bash
claude plugin test plugins/chantier
claude plugin validate plugins/chantier
```
