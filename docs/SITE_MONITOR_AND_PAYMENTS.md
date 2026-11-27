# 原站监控与支付捕获

这两个功能都在「站点 → 编辑站点」里，默认关闭，按站点独立配置。

- **原站监控**：定时抓取原站的一个页面，发现前端版本或页面内容变化时，用 PushPlus 推送消息。
- **支付捕获**：监听原站下单接口的 JSON 响应，把订单保存成一条「支付任务」，再把二维码或支付链接交给后台或手机助手。

它们都不会登录原站、不会修改原站，也不会输入支付密码或点击最终付款按钮。

---

## 一、原站监控

### 1. 什么时候用

原站前端经常换 bundle，旧缓存或旧脚本可能突然失效。监控可以发现：

- 页面标题、meta 版本号变化；
- `script src`、`link href` 变化（新前端包）；
- 指定正则匹配到的文本变化；
- 或整页 HTML 的任何变化。

### 2. 配置步骤

1. 登录后台，进入「站点」，点站点卡片上的「编辑」。
2. 展开「原站监控」。
3. 打开「监控开关」。
4. 填写「监控路径」，例如 `/purchase`。这里填原站路径，不要带 `/666` 这样的代理前缀。
5. 选择「指纹模式」：
   - **自动**（推荐）：比较标题、meta、脚本和样式链接。前端换包时最敏感。
   - **正则**：只比较正则匹配到的内容，适合盯某个版本号或构建号。
   - **哈希**：整页 HTML 有任何变化都算变化，最敏感，也最容易误报。
6. 设置「检查间隔」，最小 30 秒，默认 300 秒。
7. 保存。

第一次检查只保存基线，默认不推送。之后发现变化才会推送。

### 3. 8888ok 示例

```text
监控开关：开
监控路径：/purchase
指纹模式：自动
检查间隔：300
请求超时：15
首次基线通知：否
抓取失败通知：是
包含脚本和样式链接：是
PushPlus Token 环境变量：IH_PUSHPLUS_TOKEN
标题模板：原站更新: {site}
```

标题模板支持这些占位符：`{site}`、`{id}`、`{url}`、`{fingerprint}`、`{time}`。

### 4. PushPlus 怎么配

后台表单里只填**环境变量名**，真实 Token 放服务器：

```bash
# /etc/iframe-host/secrets/automation.env
IH_PUSHPLUS_TOKEN=你的真实Token
```

```bash
chmod 600 /etc/iframe-host/secrets/automation.env
systemctl restart iframe-host
```

systemd 服务需要用 `EnvironmentFile=` 读取这个文件。配置好后，在后台点「发送测试通知」。测试的是**已保存**的配置，所以先保存再测试。

### 5. 状态与排查

- 状态文件：`/etc/iframe-host/site-monitor-state.json`（可用 `SITE_MONITOR_STATE_FILE` 改）。
- 状态接口：`GET /<admin>/api/sites/<siteId>/monitor/status`。
- 立即检查：`POST /<admin>/api/sites/<siteId>/monitor/check`。
- 测试推送：`POST /<admin>/api/sites/<siteId>/monitor/test-notify`。

常见结果：

- `token_not_configured`：服务器没有读到对应环境变量。
- `monitor HTTP 404`：路径写错，或原站需要登录。
- 首次没有消息：正常，第一次只建基线。需要首次也通知时，把「首次基线通知」改成「是」。

---

## 二、支付捕获

### 1. 工作原理

```text
用户浏览器（原站页面）
  └─ fetch / XHR 返回下单 JSON
       └─ 页面注入的 capture.js 读取 JSON
            └─ POST /__ih/payment/capture/<siteId>
                 └─ 按字段映射生成 PaymentIntent
                      ├─ 后台显示二维码
                      ├─ 手机助手打开二维码/支付页
                      └─ 到账通知后结算
```

注入脚本只读取 JSON 响应，不修改响应，不读取密码。捕获只在启用了支付功能并打开「浏览器响应捕获」的站点上发生。

### 2. 配置步骤

1. 编辑站点，展开「支付自动化」。
2. 打开「支付功能开关」。
3. 选择「响应适配器」：`通用 JSON`、`XPAY / 收银台` 或 `VMQ`。
4. 打开「浏览器响应捕获」。
5. 填写「捕获 URL 规则」和匹配方式。
6. 填写字段映射。
7. 选择是否需要人工确认、是否自动派发、默认执行方式。
8. 保存。

### 3. 8888ok / XPAY 示例

真实下单请求：

```http
POST https://8888ok.cc/api/v1/payment/orders
Content-Type: application/json
```

响应（节选）：

```json
{
  "code": 0,
  "data": {
    "out_trade_no": "sub2_20261127DMeT2qLp",
    "pay_amount": 10.1,
    "payment_type": "alipay",
    "pay_url": "https://api.zxspro.cn/xpay/epay/submit.php?...",
    "currency": "CNY",
    "expires_at": "2026-11-27T18:01:39.418951+08:00"
  }
}
```

后台这样填：

```text
响应适配器：XPAY / 收银台
捕获 URL 规则：^/api/v1/payment/orders(?:[?#]|$)
匹配方式：正则表达式
订单号字段：out_trade_no
金额字段：pay_amount
二维码内容或支付链接字段：pay_url
过期时间字段：expires_at
支付渠道字段：payment_type
币种字段：currency
```

字段映射支持点号路径，例如 `data.out_trade_no`。捕获端会先找原字段，再找 `data.` 前缀，所以上面两种写法都能工作。

> 当前 `qr_content` 存的是 XPAY 收银台地址 `pay_url`。真正的支付宝二维码需要再请求收银台的 `/api/order/qrcode`，这一步适合后续做成服务端解析器；现在的框架已经能先保存订单和支付页。

### 4. 三种适配器

| 适配器 | 适合 | 默认订单号 | 默认金额 |
|--------|------|------------|----------|
| `generic` | 自己接的普通 JSON | `order_ref` | `amount` |
| `xp_pay` | XPAY / 收银台 | `out_trade_no` | `pay_amount` |
| `vmq` | VMQ Suite | `orderId` | `reallyPrice` |

### 5. 状态机

```text
detected → normalized → awaiting_user_approval → dispatched
→ waiting_settlement → settled → fulfilled
失败/异常：failed / cancelled / expired / needs_review
```

- `awaiting_user_approval`：等你确认。
- `needs_review`：到账金额或订单号对不上，必须人工看。
- `settled`：金额和订单号都核对通过。
- `fulfilled`：原站账户充值或交付完成。

后台「读取最近支付任务」可以看最近 5 条；接口是 `GET /<admin>/api/payments?site_id=<id>`。

### 6. 手机助手协议

手机只负责打开二维码、调起支付宝、读取到账通知，不负责最终付款确认。

```bash
# 注册设备（token 从服务器环境变量读取，不要写死）
curl -X POST https://hacket.top/__ih/payment/device/register \
  -H "x-ih-device-token: $IH_DEVICE_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site_id":"666ok","device_id":"phone-1","name":"Android"}'

# 领取任务（没有任务返回 204）
curl "https://hacket.top/__ih/payment/device/next?site_id=666ok&device_id=phone-1" \
  -H "x-ih-device-token: $IH_DEVICE_AGENT_TOKEN"

# 回报结果
curl -X POST https://hacket.top/__ih/payment/device/result \
  -H "x-ih-device-token: $IH_DEVICE_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site_id":"666ok","device_id":"phone-1","task_id":"...","status":"notification_seen","settlement":{"order_ref":"...","amount":"10.10"}}'
```

设备 Token 按站点读取 `device_token_env`，默认 `IH_DEVICE_AGENT_TOKEN`。所有站点共用一个值时，也可以用这个默认变量。

### 7. 安全边界

- 不读取、不保存支付密码。
- 不自动点击「确认付款」。
- 到账必须同时匹配订单号和金额；不匹配进入 `needs_review`。
- 同一个站点、同一个订单号只保留一条活跃任务，避免重复充值。
- Token、SecretKey 只放服务器环境变量，不进源码、文档、日志或提交记录。

---

## 三、生产部署清单

1. 上传新增文件：

```text
site-monitor.js
payment-service.js
payment-routes.js
payment-adapters/generic.js
payment-adapters/xp-pay.js
payment-adapters/vmq.js
payment-adapters/index.js
public/payment-capture.js
docs/SITE_MONITOR_AND_PAYMENTS.md
```

2. 创建目录：

```bash
mkdir -p /opt/iframe-host/payment-adapters /opt/iframe-host/public /opt/iframe-host/docs
```

3. 配置环境变量（不要打印明文）：

```text
IH_PUSHPLUS_TOKEN=...
IH_DEVICE_AGENT_TOKEN=...
```

4. 确认状态文件目录可写：

```text
/etc/iframe-host/site-monitor-state.json
/etc/iframe-host/payment-state.json
```

5. 重启并验证：

```bash
systemctl restart iframe-host
systemctl is-active iframe-host
curl -s http://127.0.0.1:3030/__ih/payment/capture.js | head
```

6. 在后台保存站点后，确认 `/666/purchase` 的 HTML 里出现：

```html
<script defer src="/__ih/payment/capture.js" ...></script>
```

---

## 四、常见问题

**Q：监控一直不发消息？**
先看状态里的 `last.ok` 和 `last.error`；再看 `token_configured` 是否为 `true`。首次只建基线，不推送。

**Q：支付捕获没有生成任务？**
确认站点「支付功能开关」和「浏览器响应捕获」都已打开，且捕获 URL 规则匹配的是不带代理前缀的路径。

**Q：金额对不上怎么办？**
系统会把任务标成 `needs_review`，不会自动完成。核对原站订单金额和实际到账金额后人工处理。

**Q：手机助手能自动付款吗？**
不能。它只能打开二维码、调起支付应用、读取到账通知和回报结果。最终付款确认必须由用户完成。
