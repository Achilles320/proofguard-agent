# ProofGuard 第一阶段：部署与预检

当前版本只实现 HTTP 接口和签名预检，不是完整比赛 Agent。没有接入 OpenAI、生成证明或提交 zkVerify；不要使用这个版本参加计分轮次。健康检查明确返回 competitionReady: false。

## 已核实的官方接口

来源：https://agentgames.zkverify.io/build （2026-10-22 读取）

- 平台向完整的 HTTPS /agent 地址发送 JSON POST。
- 请求和响应都需要 x-agent-games-signature，按原始正文计算 HMAC。
- 预检 type 为 agent-games.preflight.v1，返回 {"ok":true,"protocolVersion":"v1"}。
- 密钥从后台 Rotate Secret 获取，设为 AGENT_GAMES_HMAC_SECRET。
- 证明电路下载仍标注正在准备。官方正文要求 Groth16 proof 和 public_signals，但简化示例未提供，需进一步确认。

签名算法和编码的完整规范未在所读页面明确写出。本版暂用 HMAC-SHA256 和十六进制，接收时兼容 sha256= 前缀；需通过真实预检验证。尚未实际通过平台预检。

## 本机试运行

使用 Node.js 22 或更新的受支持版本，无第三方依赖。

1. 下载本分支代码，进入目录。
2. 在终端执行 `node --test server.test.mjs`。
3. 在终端设置测试环境变量 `export AGENT_GAMES_HMAC_SECRET='local-testing-secret-change-before-deploy'`。
4. 执行 `node server.mjs`。
5. 打开 http://localhost:3000/health，检查 ok: true 和 competitionReady: false。

本机地址只能自己访问，不能填入比赛后台。

## 线上部署需要什么

选择能运行常驻 Node.js 服务、连接本仓库并提供 HTTPS 的托管平台。先核实当前价格、休眠限制和环境变量支持；本项目没有指定或购买任何付费服务。

部署设置：

| 设置 | 内容 |
|---|---|
| 代码分支 | feat/preflight-bootstrap（合并后可选 main） |
| 构建命令 | 无需构建 |
| 启动命令 | node server.mjs |
| 健康检查路径 | /health |
| 环境变量 | AGENT_GAMES_HMAC_SECRET：平台 Rotate Secret 显示的真实值 |
| 端口 | 自动读取平台提供的 PORT，默认 3000 |

操作顺序：先创建服务获得域名，在比赛后台 Edit agent 填入 https://实际域名/agent；点击 Rotate Secret，将真实值直接填进托管平台环境变量并重启；运行 Preflight。密钥不要写入仓库、截图或聊天。若平台把预检通过自动视为 active，先暂停该 Agent 或退出计分派发，直到完整实现就绪。当前版本收到正式任务会返回 503。

## 下一阶段的完成条件

1. 获取官方电路、证明密钥、witness 说明、完整响应 schema 和 reason_code 枚举。
2. 接入 OpenAI Responses API；使用账户实际可用的模型，核实模型名称与价格。ChatGPT 订阅不等于 API 额度。
3. 实现金额整数比较、密钥/收款人/期限校验、持久化去重和重复证明识别。
4. 按官方要求生成证明，并确认验证网络与最终确认方式。
5. 通过官方练习测试后才进入计分轮次。

当前内存 nonce 缓存只用于单进程预检，重启会清空，不适用于完整比赛状态管理。所有本地测试只验证实现，不证明线上协议兼容性。
