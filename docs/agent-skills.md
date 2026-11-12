# Agent usage Skill

The portable [`rowweave-tables` Skill](../skills/rowweave-tables/SKILL.md) teaches an agent how to operate an existing RowWeave workspace through MCP or the CLI. It covers current-schema discovery, typed values, stable IDs, versioned batches, conversion/CSV preview, relationships, views and recovery from conflicts or uncertain writes. It does not add tools, grant access or start a service.

Copy the complete `skills/rowweave-tables/` directory, including `references/`, into the Skill directory supported by your agent host, keeping its `SKILL.md` at the root of that folder. CI provides the same directory in the `rowweave-agent-skill` artifact. Use the host's Skill discovery/reload mechanism and confirm that `rowweave-tables` appears. Hosts that only accept instruction files can read the entry point and linked reference manually; this is not automatic installation support for every host.

Configure the [MCP adapter](mcp.md) separately, or install and configure the [CLI](../apps/cli/README.md). Keep `ROWWEAVE_TOKEN` in private host environment settings. The Skill contains no credentials and should not be customized with real workspace IDs or tokens. Updates replace the Skill files; they do not change workspace data or connection configuration.

Example requests:

- "Create Projects and Tasks with a status field, a due date and a link from each task to its project."
- "Show overdue open tasks, then mark the selected ones Done."
- "Preview converting Budget from text to numbers and explain any invalid values before applying it."
- "Preview this CSV mapping, import the reviewed rows, and export my saved Active view."

The Skill preserves existing user authorization and narrows ambiguous changes before writing. It does not require repeated confirmation for every operation. In particular, a lost write response is not permission to retry an import: the agent should first determine whether rows already committed.

Validation uses the Skill-authoring environment's metadata/scaffold validator and checks the recipes against current MCP/CLI contracts and the real protocol workflows in `apps/mcp/tests/`. Those checks do not certify an agent's judgment. Use an isolated workspace when evaluating a particular host/model, including a version conflict and a deliberately interrupted write response; inspect saved results from the desktop or CLI.
