# 外部回调模板：从模拟到签名接收

## 这次能做什么

后台顶部“外部回调”提供模板新建、查看、修改、复制、删除 / 归档、启停和版本发布。支持最多 12 步的后端 JS / 前端 JS 排序组合。每站可以单独绑定一个已发布模板，启用签名回调接收和自动后端执行。任务事件、代码版本和结果持久保存；没有后台浏览器轮询。

**不能做什么：**这不是任意支付平台的通用回调验签器，也没有生成收款二维码、订单金额核验、主动查单、原站自动扫码充值或原站页面自动化。HMAC 只证明通知来自持有本桥接密钥的一方，不能把 `payment_verified:true` 等来路数据当成收款事实。任务的 `payment_verified` 固定为 false。“流程完成”不是收款或原站充值成功。

## 第一次使用：不需要付款或密钥

1. 登录后台，打开“外部回调”，点“新建模板”。
2. 后端步骤写 `return { amount: Number(input.amount) + 5 };`。
3. 添加前端 JS，写 `return { ...input, reviewed: true };`。
4. 再添加后端 JS，写 `return { amount: input.amount, browserUntrusted: previous[1].trusted === false };`。
5. 保存草稿，然后“保存并发布”。草稿不运行；发布后模板启用，但不会自动打开任何站点的接收开关。
6. 选择测试站点，输入 `{"event_id":"demo","amount":100}`，点“创建模拟任务（不付款）”。
7. 在任务详情点“执行 / 继续后端”，任务进入“等待浏览器步骤”。
8. 点“执行等待中的前端步骤”，确认后运行；再点“执行 / 继续后端”。最终输出 `amount:105`，浏览器结果仍标记为不可信。

前端步骤由当前登录的管理员明确执行，而不是在原站任意用户的页面自动注入。管理员离线或没有点击时任务就等待。后续如需特定用户的原站会话动作，需要再实现授权会话绑定与受控浏览器能力，不复用管理员登录凭据。

## 模板与步骤

- 模板 ID 形如 `cb-...`，创建时由服务器生成。发布递增版本号，现有任务保存完整代码快照，不因后续编辑改变。
- 已绑定站点的模板必须先解除绑定才能删除；有任务历史的模板改为归档，保留追溯信息。归档模板可查看或复制，不能执行。
- 每步可以开启 / 关闭、调整顺序、名称、运行位置和 100–3000 毫秒超时。代码最多 8 KiB；每次返回 JSON 最多 16 KiB。同步后端执行中超时的代码会被打断，外层 Worker 也有终止保护。
- `input` 是当前输入（首步为回调 JSON，后续为上一有效步骤输出）；`event` 是最初的脱敏事件；`previous` 是已执行步骤的结果，元素含 `step`、`type`、`output`、`trusted`。前端结果的 trusted 为 false；后端执行可信不代表业务内容可信。
- 用 `return` 传递结果，未返回按 null 处理。后端不支持 Promise；前端支持 Promise / await。不要只修改 input 而不返回。
- 后端由独立 Node Worker 托管 QuickJS/WASM，解释器内存上限 16 MiB，栈上限 256 KiB；代码没有 Node require、process、环境变量、文件或网络能力，不使用 Node vm 充当安全边界。
- 前端在 sandbox iframe 内启动可终止 Worker；没有原站 DOM、后台 DOM、Cookie、API token 或网络。CSP 阻止出站连接。不能写 document.querySelector 去操作原站登录 / 付款控件。
- 不传入请求 Cookie、Authorization、回调签名或商户密钥。JSON 中名字含 password、secret、token、authorization、cookie、api_key、signature 等的键会脱敏。这不保证所有自由文本都不含敏感信息，发送方仍须主动最小化数据。

## 接收外部回调

1. 选择并发布模板，复制模板 ID。
2. 编辑目标站点，找到“外部回调绑定”，从候选模板 ID 中选择或粘贴。
3. 密钥环境变量名默认 `IH_CALLBACK_SIGNING_KEY`。多站点建议使用不同变量，例如 `IH_CALLBACK_SITE_A`。变量名必须以 `IH_CALLBACK_` 开头，表单里只填名字，不填密钥。
4. 在 Linux systemd 服务的受保护 EnvironmentFile 中配置至少 32 字节的强随机密钥，文件仅给运维 / 服务账号需要的权限，不提交到 Git，不在终端日志打印。服务需要重启才能读取新环境值；先确认没有活跃验证码或回调任务。
5. 打开“接收签名回调”，保存。点“检查已保存回调配置”查看密钥是否可用、已发布版本和存储健康。它不会保存未提交的表单或实际发送回调。
6. 自动执行默认关闭：通知会落盘成为“待执行”，管理员手动处理。开启后只自动执行连续后端步骤；遇到前端步骤仍等待管理员。

接收地址：`https://你的域名/__ih/callback/站点ID`，不是 `/666/...`，不要加站点代理前缀。仅支持 POST、未压缩 `application/json`，正文上限 64 KiB；事件持久输入上限 16 KiB，须包含唯一的字符串 `event_id`（1–128 个字母、数字、下划线、点、冒号或连字符）。

请求头：

- `X-IH-Timestamp`：当前 Unix 秒，十位十进制字符串，时钟容差 300 秒。
- `X-IH-Signature`：HMAC-SHA256 的小写十六进制值。
- 待签名字节为：UTF-8 的 `timestamp + "." + site_id + "."` 紧接**原始请求正文字节**。签名包含站点 ID，不能跨站重放。

发送方 Node 示例（密钥从发送方环境取，不打印）：

```js
const crypto = require('node:crypto');
const siteId = 'your-site-id';
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({ event_id: 'example-unique-event-001', amount: 100 });
const secret = process.env.IH_CALLBACK_SIGNING_KEY;
if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Configure signing key first');
const signature = crypto.createHmac('sha256', secret)
  .update(timestamp + '.' + siteId + '.').update(body).digest('hex');
await fetch('https://your-domain.example/__ih/callback/' + siteId, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-IH-Timestamp': timestamp, 'X-IH-Signature': signature },
  body,
});
```

成功时返回 HTTP 200、模板发布版本的“接收成功时的回执正文”（默认 success），头 `X-IH-Job-Id` 是任务 ID。回执正文只能编辑纯文本，不能用脚本绕过验签或改变是否成功接收的状态码。接收落盘完成后才 ACK，不等待整个流程结束。

**对接易支付 / 官方支付宝 / 微信等原生通知，不能直接套这个签名示例。**须先由服务端适配器按真实渠道协议验签、核订单、查金额等，再转为通用桥接事件；或者后续新增原生适配。没有该适配时不要把支付平台通知地址直接改到这里，也不要假设它会携带 X-IH 签名。

## 去重、暂停、恢复与排错

- 去重键是站点 ID + event_id。相同原始正文重发不重复建任务，返回原任务 ACK；同 ID 改正文返回 409。同一个 JSON 改空格 / 键顺序也视为不同原始正文，因此重试必须复用原字节；只更新时间戳并重新签名即可。
- 发布新版本不影响已收到事件的代码和 ACK。模板停用时仍接收该站绑定模板的新有效通知，但不自动执行；关闭站点接收则返回 404，发送方应保留待投递事件。
- 失败任务不自动重试。后端或浏览器执行中重启服务，任务标记待核对；前端有一分钟一次性凭证，过期 / 已使用会拒绝提交。可“转人工核对”，不通过更换 event_id 盲目重做业务动作。
- 自动执行队列每进程最多一个任务，不长期空转轮询。重启时恢复尚未开始的 pending 自动任务；waiting_browser 不自动执行浏览器。
- 通知限流：每进程每分钟每站最多 30 次、全局 120 次。超限返回 429；错误签名也占额度，避免无上限验签消耗。需要外层 Nginx 限流防护。最多 100 个模板、200 个历史任务，存储文件最多 16 MiB；达到上限拒绝新事件，不丢弃去重凭证。
- 状态默认保存在配置目录的 `callback-state.json`，可用服务环境 `CALLBACK_STATE_FILE` 指向专用目录。使用临时文件、fsync、原子替换；存储损坏或写失败会关闭接收和执行，不把失败伪装成功。
- 当前状态文件面向**单服务实例**，不要多个进程共用同一文件。多副本需要未来迁移到带唯一约束和事务的数据库；当前没有自动清理 / 删除任务功能，避免丢失去重证据。备份必须保留权限与敏感性。
- 401：签名错误 / 过期；404：站点关闭 / 不存在；409：未发布、重复事件内容冲突或步骤状态不允许；413：正文超限；415：类型 / 压缩不支持；429：限流；503：密钥缺失、存储不可用或任务上限。
- 页面默认只手动刷新最近 100 个任务，详细结果按需读取。日志不打印脚本异常原文、Token 或密钥。框架仍会保存发送方选择的业务 JSON，应尽量只发送订单引用和最少必要字段。

## 部署与检查

使用 lockfile 安装固定依赖 `npm ci --omit=dev`，必须一并部署 `callback-service.js`、`callback-routes.js`、`callback-script-worker.js`、`public/callback-admin.js` 和 `public/callback-browser.html`。旧的仅上传 server.js 的部署方式不再适用；`deploy-current-fix.py` 已加保护，防止缺失依赖时覆盖运行中的服务。

部署命令为 `python ops/deploy/deploy-callbacks.py`：远程独立目录先安装固定依赖并运行解释器烟测，确认无活跃验证码 / 回调任务后才备份、切换和重启，失败自动回滚文件与依赖；生产配置保持原样，不自动打开回调开关。Linux 安装直接联网，不使用工作站代理。

运行 `npm run check`、`node test-multisite-integration.js`。回调单测使用本地随机测试密钥和虚拟事件，覆盖错误签名、跨站、过期、重复通知、版本快照、混合步骤、超时、重启、存储损坏、容量与 HTTP 权限，不调用支付平台、不付款、不触发付费验证码。
