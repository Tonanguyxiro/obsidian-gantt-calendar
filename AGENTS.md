# Agent session protocol

Session rules for coding agents (Codex, Claude, …) working in this repo.

## 1. Where the project rules live

- Build and test commands, architecture, code conventions and Git rules: `CLAUDE.md` at the repo root. Every agent must follow it.
- End-to-end testing in real Obsidian (fixtures, acceptance checklist, check scripts in `tools/`, gantt-calendar pitfalls): `TESTING.md`.
- Workspace-wide setup and general Obsidian testing pitfalls: `../AGENTS.md`.
- Roadmap and to-do tracking: maintained externally in the user's personal notes rather than inside this repository.

## 2. Git rules

- Follow the Git rules in `CLAUDE.md`: agents never commit or push on their own.
