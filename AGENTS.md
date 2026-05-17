# Repository Guidelines

## Browser QA

- Default to `agent-browser` for browser QA, research, links, and page inspection.
- Use Hermes `computer_use` with the existing Brave Browser session only when the task needs active logged-in browser state, existing tabs, local device/session context, or the user explicitly asks for Brave/computer_use.
- When using `computer_use`, scope it to Brave, capture before clicking, verify after state changes, and do not interact with passwords, 2FA, payment UI, permission dialogs, or unrelated personal tabs without explicit user direction.
