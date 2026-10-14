# WeAre

> Autonomous AI agent that runs WhatsApp conversations with event guests in Dubai.

<p align="center"><img src="docs/wordmark.png" width="420"></p>

<h5 align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#tech-stack">Tech stack</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#deployment">Deployment</a>
</h5>

WeAre talks to party guests on WhatsApp on behalf of the organizer: answers questions about upcoming events, puts guests on the guestlist, records table requests, and hands the chat to a human when needed. In production since July 2026.

## How it works

```
WhatsApp Cloud API
      │  POST /webhook (signature-checked)
      ▼
Webhook.ts ── upsert guest + chat, store message ──► PostgreSQL
                                                        │
Worker.ts ◄── atomic claim: UPDATE … RETURNING ─────────┘
      │
      ▼
Agent.ts  (loop, up to 12 steps)
  system prompt + <parties> block + state checklist
      │
      ▼
Claude ──► tool_use ──► send_message | save_guest | pause_chat
                              │
                              ▼
                    PostgreSQL + WhatsApp send
```

The model never writes to the guest directly. It only decides and calls tools with strict Zod schemas; all facts about the guest and the event are loaded from PostgreSQL and assembled into a deterministic state block on every step.

| Tool | Does |
|---|---|
| `send_message` | Sends one or more WhatsApp bubbles |
| `save_guest` | Writes the guest profile and guestlist entry: name, Instagram, companions, table answer |
| `pause_chat` | Hands the chat to the organizer and pauses it |

## Tech stack

| | |
|---|---|
| Runtime | Node.js, TypeScript, ESM |
| LLM | Anthropic Claude via `@anthropic-ai/sdk` |
| Messaging | WhatsApp Cloud API, Telegram Bot API |
| Database | PostgreSQL, plain SQL |
| HTTP | `itty-router` |
| Validation | Zod |
| Tooling | pnpm, Biome, tsx, `node:test` |

## Project structure

```
src/
  Webhook.ts        WhatsApp webhook process
  Worker.ts         queue worker + background jobs
  Intelligence/     agent loop, context, state block, prompts, tools
  Platforms/        WhatsApp API
  Db/               storage layer
  Jobs/             guestlist export, pause alerts, RSVP
  Dashboard/        admin API
migrations/         database schema
tests/              e2e, attack tests and dialogue probes
```

## Getting started

```sh
pnpm install
psql "$DATABASE_URL" -f migrations/init.sql

pnpm dev            # webhook
pnpm dev:worker     # worker + jobs
```

Dialogue probes run scripted guest conversations through the real agent and the live model:

```sh
pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Dialog.ts
```

## Deployment

```sh
docker build -t sema-ai:<version> .
VERSION=<version> docker compose up -d
```
