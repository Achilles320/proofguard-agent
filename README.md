# ProofGuard

面向 zkVerify Agent Games / Proof Gatekeeper 的轻量 AI Agent（默认 DeepSeek，可选 OpenAI）。

**当前版本是基础服务与练习分类原型，不是可正式计分的完整参赛程序。**

## 已实现

- Node.js 24，无第三方运行依赖；`GET /healthz` 和 `POST /agent`。
- 原始请求体 HMAC 验签、响应签名、官方预检响应格式。
- DeepSeek Chat Completions + JSON Output，或 OpenAI Responses API + JSON Schema；精确整数规则复核，模型与规则不一致时停止处理。
- 请求时限、任务幂等、单实例串行处理、证明重复使用练习记录。
- 每 UTC 日模型调用次数上限，状态文件原子写入；失败不记录成功任务。
- 默认 `AGENT_MODE=preflight`，**始终拒绝 competition 任务**，防止未完成证明时误参赛。

## 仍待接入与验证

1. 官方 Groth16 `.wasm`、`.zkey`、验证密钥、witness 定义和完整响应 schema。
2. zkVerify 的真实链上证明验证、网络选择、费用与最终确认等待。
3. 官方 HMAC 算法、secret 编码、digest 编码。当前实现假设 SHA-256 + UTF-8 secret + hex digest，可配置编码；必须用官方预检验证兼容性。
4. 官方练习中的过期等号边界、多重错误优先级、证明缺失的响应规范。
5. 真实 DeepSeek 调用与账户余额（没有密钥时只进行模拟 API 测试）。

**程序不会伪造证明，不会把 task.proof_tx 当作链上验证成功。**练习模式中的 APPROVE 只表示输入字段检查通过，不具备密码学验证结论。

## 本地运行

需要 Node.js 24 或以上。

```bash
npm ci
cp .env.example .env
# 在本机编辑 .env，填写密钥；不要提交该文件。
node --env-file=.env src/server.js
```

```bash
npm test
npm run check
```

## Render 部署

创建单个 **Web Service**：

- 仓库：https://github.com/Achilles320/proofguard-agent
- Branch：`main`
- Runtime：Node
- Build Command：`npm ci`
- Start Command：`npm start`
- Health Check Path：`/healthz`
- Node 版本：通过 `NODE_VERSION=24` 固定。
- 第一次上线保持 `AGENT_MODE=preflight`，可以不设置真实密钥；此时任务接口返回未配置，健康接口正常。

在 Render 的 Environment 中填写 `DEEPSEEK_API_KEY` 和平台生成的 `AGENT_GAMES_HMAC_SECRET`。不要发到聊天、写进仓库或日志。

免费服务仅适合初次检查，休眠可能导致错失任务。正式比赛需要常驻服务与持久存储；本版本不具备正式比赛资格，先不要为比赛升级付费资源。

状态默认写入 `./data/state.json`。Render 临时文件系统在重建/部署后可能丢失；正式使用前需要持久磁盘并设置 `STATE_PATH=/var/data/proofguard/state.json`。仅支持一个服务实例；不支持多副本共享状态。

## 报名与预检

1. Agent 名称填写 ProofGuard，选择 Proof Gatekeeper，Repository 填上述仓库。
2. 服务上线后，Agent Endpoint 填完整 `https://实际服务域名/agent`。
3. 在 Agent Games 后台 Rotate Secret，将一次性明文保存到 Render 环境变量并重新部署。
4. 运行官方 preflight。响应为签名的 `{ "ok": true, "protocolVersion": "v1" }`。
5. 预检通过后，才考虑设置 `AGENT_MODE=practice` 验证任务分类。练习缺少 Groth16 证明，可能被平台标记为证明不完整，这是当前已知限制。
6. 官方证明接入和真实练习通过后才开放 competition。目前不存在可绕过这个限制的开关。

## 官方资料

- https://agentgames.zkverify.io/build
- https://agentgames.zkverify.io/rules
- https://agentgames.zkverify.io/events/proof-gatekeeper

无网页控制台、无数据库服务、无定时轮询。比赛任务由主办方向 HTTPS endpoint 推送。

## DeepSeek 切换（v0.2.0）

在 Render Environment 设置：

| 变量 | 值 |
| --- | --- |
| LLM_PROVIDER | deepseek |
| DEEPSEEK_MODEL | deepseek-flash |
| DEEPSEEK_API_KEY | 自己在 DeepSeek 官方平台生成的密钥 |
| LLM_TIMEOUT_MS | 12000 |

模型调用地址固定为官方 https://api.deepseek.com/chat/completions，使用 JSON Output，并显式关闭 thinking 以降低延迟。程序会校验输出字段、完整性与规则一致性。密钥缺失时返回明确错误，不会使用 OpenAI 密钥访问 DeepSeek，也不会自动切回 OpenAI。

健康检查返回 provider、model、modelKeyConfigured，不显示密钥。旧的 OPENAI_API_KEY 可留存但在 DeepSeek 模式不使用，也可以自行删除。比赛 HMAC 密钥继续保留。

DeepSeek 返回 401 表示认证失败、402 表示余额不足、429 表示限流；练习页面可能统一显示 502，具体类别可在 Render 日志查看。

官方参考：
- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/guides/json_mode/
- https://api-docs.deepseek.com/guides/thinking_mode/
