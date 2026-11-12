# RowWeave

[English](README.md) | 简体中文

**让表格适应你的工作，让数据连接你的应用和 AI Agent。**

无需编写表结构代码，就能搭建项目跟踪表、客户清单或库存台账。RowWeave 将可自定义的表结构、流畅的桌面表格和开放接口放在一起，连接你已有的软件和工作流程。

- **按业务定义结构。** 自定义表和字段，使用文本、数字、日期、复选框和选项；用公式计算字段，关联其他记录，通过查找字段显示关联数据或汇总结果。
- **只看当前需要的信息。** 在表格与状态看板间切换，保存筛选和布局，移动卡片调整分组，查看整个视图的数量、合计与平均值。
- **高效完成日常编辑。** 用键盘编辑，整块粘贴，撤销草稿，再一起保存。通过 CSV 导入和导出数据。
- **连接你的工具。** 使用 HTTP API、TypeScript SDK、CLI、MCP 或 Agent Skills；也可在 DeepSeek Harness 面板中使用同一套表格工作区。
- **决定数据放在哪里。** 从 Windows 本机开始，或连接自行部署的服务。人工编辑与软件操作遵循相同的校验和版本检查。

## 体验 RowWeave

首个产品候选版本已可供评估。从成功的 [CI 运行记录](https://github.com/euyuil/rowweave/actions)下载 **rowweave-windows**，解压其中的应用 ZIP，打开 `rowweave.exe`。桌面版无需额外安装 Node.js。

从空白工作区开始：创建表，添加字段，再录入或导入记录。点击 **Save changes** 或按 **Ctrl+S** 保存修改。

[桌面连接（英文）](docs/connections.md) · [CSV 指南（英文）](docs/data-exchange.md) · [验收步骤（英文）](docs/acceptance.md)

## 连接你的软件

[部署服务（英文）](docs/service.md) · [TypeScript SDK（英文）](packages/client/README.md) · [CLI（英文）](apps/cli/README.md) · [MCP（英文）](docs/mcp.md) · [Agent Skills（英文）](docs/agent-skills.md) · [Harness（英文）](docs/harness.md)

本版专注灵活的结构化表格和可靠的数据操作。内置 AI 聊天、企业级权限和实时协同编辑仍不在本轮范围内。

实测性能与当前限制见[验证报告（英文）](docs/product-performance.md)。源码运行与架构见[开发文档（英文）](docs/development.md)和[设计文档（英文）](docs/design.md)。欢迎在 [Issues](https://github.com/euyuil/rowweave/issues) 中分享使用场景和反馈。
