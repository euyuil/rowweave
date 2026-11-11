# RowWeave

English | [简体中文](README.zh-CN.md)

**Structured tables for your team, your apps, and your AI agents.**

RowWeave is being built to give people and software a shared place to work with business data. Define the structure your team needs, manage records in a desktop table interface, and let applications and AI agents work with the same data through clear interfaces.

> **Project status:** The first Windows desktop prototype is available to run from source. It demonstrates local table editing and reliable saves with a fixed sample table. Custom schemas, team hosting, and agent integrations are still planned.

## Why RowWeave?

- **Shape your data around your work.** Organize customer lists, project records, inventories, and other business data with tables and fields you define.
- **Work in a familiar table interface.** Browse, edit, select, and paste data in a desktop app.
- **Give people and agents the same foundation.** Planned APIs and tools let applications and AI agents discover table structures, query records, and make validated updates.
- **Start on your own machine.** Run locally, with a path toward hosting one shared data service for your team.
- **Keep data operations dependable.** Shared validation, atomic batch updates, and version checks are design priorities, so automation and manual edits follow the same rules.

## Built for teams that work in tables

RowWeave is aimed at teams that want the flexibility of custom tables, the convenience of a desktop app, and a clear way to connect their data to other software.

Its focus is structured records and reliable operations. Excel-style formulas, built-in AI chat, and offline synchronization are outside the initial scope.

## Try the desktop prototype

Open 10,000 sample records, edit cells, paste a block from a spreadsheet, and save your changes locally. Saved values survive a restart. Version checks prevent a conflicting update from silently overwriting your work.

Follow the [setup and run instructions](docs/development.md#desktop). This is an early prototype with text fields and a fixed table, intended for evaluating the workflow.

Custom table structures, field types, filtering, sorting, and CSV import/export will follow. Team hosting, SDKs, MCP, CLI, and agent skills remain part of the broader direction.

## Follow the project

- Browse [issues](https://github.com/euyuil/rowweave/issues) or open one to share your use case and the workflows that matter to you.
- For architecture, prototype scope, and development plans, read the [design document](docs/design.md).
