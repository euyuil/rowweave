# RowWeave

English | [简体中文](README.zh-CN.md)

**Structured tables for your team, your apps, and your AI agents.**

RowWeave is being built to give people and software a shared place to work with business data. Define the structure your team needs, manage records in a desktop table interface, and let applications and AI agents work with the same data through clear interfaces.

> **Project status:** RowWeave is in the design and prototype planning stage. No runnable application or installation package is available yet. The capabilities below describe the product direction and have not been implemented.

## Why RowWeave?

- **Shape your data around your work.** Organize customer lists, project records, inventories, and other business data with tables and fields you define.
- **Work in a familiar table interface.** Browse, edit, select, and paste data in a desktop app, with Chinese input support included in the prototype plan.
- **Give people and agents the same foundation.** Planned APIs and tools let applications and AI agents discover table structures, query records, and make validated updates.
- **Start on your own machine.** Run locally, with a path toward hosting one shared data service for your team.
- **Keep data operations dependable.** Shared validation, atomic batch updates, and version checks are design priorities, so automation and manual edits follow the same rules.

## Built for teams that work in tables

RowWeave is aimed at teams that want the flexibility of custom tables, the convenience of a desktop app, and a clear way to connect their data to other software.

Its focus is structured records and reliable operations. Excel-style formulas, built-in AI chat, and offline synchronization are outside the initial scope.

## What's coming first

The first prototype will focus on a complete desktop workflow: open a table, edit cells, copy and paste, save changes, and read them back after a restart. It will also validate Chinese input and responsiveness with larger tables.

Custom table structures and field types, filtering and sorting, and CSV import and export will follow. HTTP API and TypeScript SDK access, MCP, CLI, and agent skills are part of the broader direction, with a basic HTTP interface supporting the prototype.

## Follow the project

- Browse [issues](https://github.com/euyuil/rowweave/issues) or open one to share your use case and the workflows that matter to you.
- For architecture, prototype scope, and development plans, read the [design document](docs/design.md).
