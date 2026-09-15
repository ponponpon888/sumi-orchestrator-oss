# SUMI Orchestrator v0.1 — Design

## Problem

AI coding capability is already strong. The operational gap is continuity: work state is spread across chats, Claude Code/Codex sessions, GitHub, Vercel and Supabase.

## Goal

Answer these questions immediately and reproducibly:

1. What is done?
2. What is being worked on now?
3. What is blocked?
4. What has actually reached production?
5. Why was a key technical decision made?
6. What should happen next?

## Source-of-truth model

SUMI v0.1 is deliberately small. It stores five domains:

- Project
- Task
- Decision
- Deployment
- Next Action

The CLI state is local-first JSON. Every mutation is appended to an audit JSONL file.

## Completion semantics

`implementationDone = all non-cancelled tasks are done`

`complete = implementationDone AND deployment.production == verified`

This prevents an AI from calling work complete just because code was written or a build passed.

## Non-goals

- Reimplement Claude Code/Codex
- Edit source code
- Run autonomous coding loops
- Deploy production
- Manage secrets
- Replace GitHub/Vercel/Supabase

Those systems remain execution/data sources. SUMI is the orchestration/state layer.
