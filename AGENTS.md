# Repository Guidelines

## Branch Workflow

- Use a dedicated linked worktree when it provides useful task or session isolation. Inspect existing worktrees, fetch/prune `origin`, then create a unique short-lived `codex/*` branch from the current remote default under `.worktrees/<branch-slug>`.
- Give each worktree one owner and purpose. Preserve dirty, active, unfinished, unmerged, or uncertain work; never reuse, switch, stash, reset, remove, or force it. Update remaining task branches after the default branch moves and rerun focused checks.
- Keep the default branch clean. After merge or explicit abandonment, remove only the exact clean worktree, safely delete its local branch, and run `git worktree prune`. Stop before commit, push, PR, or deployment unless explicitly requested.

## Browser QA

- Default to `cloakbrowser` for browser QA, research, links, and page inspection.
- Use Hermes `computer_use` with the existing Brave Browser session only when the task needs active logged-in browser state, existing tabs, local device/session context, or the user explicitly asks for Brave/computer_use.
- When using `computer_use`, scope it to Brave, capture before clicking, verify after state changes, and do not interact with passwords, 2FA, payment UI, permission dialogs, or unrelated personal tabs without explicit user direction.
