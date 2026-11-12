# Agent session protocol

Session rules for coding agents (Codex, Claude, …) working in this repo.

## 1. Where the project rules live

- Build and test commands, architecture, code conventions and Git rules: `CLAUDE.md` at the repo root. Every agent must follow it; this file only adds progress tracking.
- End-to-end testing in real Obsidian (fixtures, acceptance checklist, check scripts in `tools/`, gantt-calendar pitfalls): `TESTING.md`.
- Workspace-wide setup and general Obsidian testing pitfalls: `../AGENTS.md`.

## 2. TODO.md protocol

`TODO.md` at the repo root is the single to-do and progress file.

Every session, in this order:

1. **Start**
   - Read all of `TODO.md`.
   - Check the in-progress, to-do and new-requests sections to recover the last state.
   - Do not reconstruct context from memory alone.
2. **New requests during the session**
   - Add every new feature, fix, refactor, release, doc or investigation request to `TODO.md` promptly.
   - Put it under the matching plan/phase if it fits one; otherwise in the "💡 新需求" (new requests) section.
   - Use `- [ ]` items with the goal and the key acceptance points.
3. **End**
   - Re-read and update `TODO.md`.
   - Mark finished items `- [x]`, move them to "✅ 已完成" (done) with the date.
   - Keep partly done items in "📌 进行中" (in progress) with the remaining steps spelled out.
   - Leave not-started or postponed items in their sections.
   - Never delete finished history; keep commit hashes where known.

## 3. Recording rules

- Only record what was actually done, and only after the needed build, tests or manual verification.
- Never invent dates, commit hashes or test results.
- Keep `TODO.md` in Chinese, short and scannable.
- Follow the Git rules in `CLAUDE.md`: agents never commit or push on their own.
