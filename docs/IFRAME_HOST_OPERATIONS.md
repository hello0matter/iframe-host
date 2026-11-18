# iframe-host 生产运维手册（简版）

## 当前线上状态（2026-07-23 已验证）

| 组件 | 地址/端口 | 说明 |
| --- | --- | --- |
| Nginx | 80/443 | 公网入口、TLS、路由 |
| Node 多站点代理 | 127.0.0.1:3030 | 站点前缀匹配、资源改写、访客统计 |
| Java Yudao API | 127.0.0.1:48080 | 仅 API，无前端页面 |

### 公开路由

| 路径 | 用途 |
| --- | --- |
| `/` | 若配置了 `proxy_prefix=/`（或空）的站点，则由 Node 代理；否则 404 |
| `/a/` | 代理站点 runcortex.xyz |
| `/apii/` | 代理站点 catfk.com |
| `/internal-content/` | 旧默认前缀（可按配置） |
| `/internal-content-admin/` | 管理后台（映射到 Node `/admin/`） |
| `/yudao-api/` | Java API（未登录返回 401 JSON，不是网页） |

域名：`https://hacket.top` / `https://www.hacket.top`（HTTP 跳 HTTPS）

### 关键规则

1. Node 代理的 `proxy_pass` **不能**写尾斜杠：`proxy_pass http://127.0.0.1:3030;`
2. 通用 CSS/图片正则 location 必须转发给 Node，否则会命中面板本地 404，导致无样式页面。
3. 访客分析：已自动记录，**无弹窗、不请求定位**。
4. 请求/响应正文审计按站点开关。后台把 Audit probe 设为 On 后才会落盘；每个站点最多保留 300 条、64MB，超出后删最旧记录，避免再次占满磁盘。
5. 代理会自动改写 HTML/CSS/JS/JSON 中的站点 URL，并处理 SPA 动态加载的资源；压缩文本响应会先解压再改写和审计。
6. 审计写入按站点异步排队，不阻塞页面响应；后台查看审计时可能有极短的落盘延迟。
7. `hacket.top` 的 HTTPS 虚拟主机直接转发到 `127.0.0.1:3030`，不要再经由 IP 虚拟主机转发，否则会增加一跳并污染 Host。
8. 默认上游不可达时，Node 会在 4 秒后使用 `/etc/iframe-host/fallback-cache.json` 中的预热页面、CSS、脚本和图片；同一上游会熔断 30 秒，避免浏览器的并发资源请求反复卡住。执行 `npm run refresh-fallback-cache` 可重新生成该缓存，部署脚本检测到 `.cache/fallback-cache.json` 时会一并上传。

## 管理后台：中英文与内置帮助

- 登录后打开 **全局设置 → 界面语言**，选择 **中文 / English** 即可切换整个后台和使用说明；不再在登录页、顶部导航单独显示语言切换按钮。
- 选择结果保存在当前浏览器的 `localStorage`（键 `proxyAdminLang`），刷新或重新登录后保持。
- 语言选择立即生效，不需要保存服务器设置；修改管理员账号、密码或采集上限时仍需要点击 **保存全局设置**。
- 登录后的 **使用说明** 按钮提供统一说明入口，页面顶部的目录可跳转查看站点字段、保存错误、全局设置、语言切换、兼容与审计、访客分析、替换规则、响应键值脚本、URL 拦截脚本、排错和安全提示。
- 站点编辑和全局设置弹窗也提供 **使用说明** 按钮；查看后点击 **返回站点** 会返回原弹窗，保留尚未保存的输入。
- 语言切换只影响管理后台界面，不会改变被代理站点的页面内容。

### 站点 ID 报错处理（2026-11-13）

- `ID` 是内部标识，不是显示名称或网址；允许 1–64 位英文字母、数字、连字符和下划线，必须以字母或数字开头，例如 `my-site`。中文名称填写在 **显示名称**。
- 点击保存时先在浏览器检查 ID、显示名称和 HTTPS 地址，错误时高亮、聚焦并滚动到对应字段，同时显示当前语言的解释；未通过检查不会发送保存请求。
- 服务端仍保留校验；ID 重复、前缀冲突、错误登录凭据等常见错误会转换为当前界面语言，不再直接显示截图中的 `site id: 1-64 chars [A-Za-z0-9_-]`。
- `npm run check` 包含后台脚本语法、词条对齐、错误翻译、表单校验和说明目录回归测试；完整代理回归仍运行 `node test-multisite-integration.js`。

## 站点 URL 拦截脚本

- 每个站点可在「编辑站点 → URL 拦截脚本」中单独开启，支持普通文本或正则匹配。
- 请求命中规则后，代理不会访问上游，而是直接在 Node 进程内执行配置的 JavaScript，并返回脚本生成的结果。
- `request` 提供 `method`、`path`、`query`、`url`、`headers`、`cookies`、`body`；`site` 提供当前站点信息；`console.log` 输出到服务日志。
- 脚本需同步执行，返回字符串，或 `{ status, headers, body, content_type }`；默认超时 1000ms，可配置 50–5000ms。
- 拦截脚本属于管理员可信代码，仅在明确需要替换上游响应时开启；关闭开关后立即恢复为正常代理。

## 站点响应键值脚本

- 每个站点可在「编辑站点 → Response value scripts / 响应键值脚本」中单独添加多条规则，规则按顺序执行；每条规则都可以独立启用或关闭。
- 规则按上游响应 URL 与请求路径匹配（普通文本或正则，与 URL 拦截脚本使用同一套匹配方式）。只有命中的 URL 才会执行对应脚本，未命中的页面完全不受影响。
- 取值位置 `target` 支持四种：`json`（JSON 正文键路径）、`header`（响应头）、`form`（`application/x-www-form-urlencoded` 表单字段）和 `text`（正文正则）。
- JSON 键路径支持点号和数组下标，例如 `data.token`、`items[0].price`；`text` 的键是正则，存在第一个捕获组时替换捕获组内容，否则替换整个匹配。
- 脚本中可直接使用：`value`（当前取到的值）、`key`（当前键或正则）、`request`（方法、路径、查询串、URL、请求头、cookies）、`response`（状态码、上游响应头）、`site` 和 `console.log`。
- 返回值写回原位置：返回字符串或数字会转换为字符串；返回 `undefined` 表示保持原值；`header` / `form` 返回 `null` 会删除该键；JSON 返回 `null` 会写入 `null`。
- 脚本同步执行，默认超时 1000ms，可配置 50–5000ms。脚本异常只记录日志并保持原值，不会中断正常代理。
- 为防止破坏响应，`content-length`、`transfer-encoding`、`connection`、`keep-alive` 不会被规则改写，`set-cookie` 数组也不会被改写。
- 命中响应正文规则时不会写入 fallback 预热缓存，避免把改写后的内容缓存成上游原始响应；关闭站点或删除规则后立即恢复原行为。

## 验证码与手动登录排查

- 多站点代理会给上游响应中以 `/` 开头的 `Location` 补当前站点前缀；已带前缀的路径不会重复添加，其他域名的跳转保持原样。例如 `/666/` 站点的 `/login` 跳转应变为 `/666/login`。此修复仅针对 HTTP 响应跳转，不代表所有 SPA 客户端路由已兼容。
- Cloudflare 验证失败不能只凭截图归因。需要检查验证脚本的网络加载、浏览器实际错误码、sitekey 允许的域名以及上游服务端验证配置。不要删除验证逻辑、伪造验证结果或通过响应替换让前端显示成功。
- 可见浏览器可以由用户本人在原站完成验证和登录；无头浏览器并不保证能完成交互验证。默认优先使用原站正常浏览器流程。
- 在原域名完成登录不等于代理域名自动登录。Cookie、localStorage、令牌、回调路径及验证环境可能不同；不能直接共享一个管理员账号的登录态给所有代理访客。本项目目前未实现浏览器登录态导入或后台浏览器托管。

## 2Captcha / Turnstile 站点配置

登录后台后，打开站点编辑中的「验证码服务」。每个站点可以独立开关，默认关闭。

- 服务商选择 2Captcha；只适用于已授权上游的普通、显式渲染 Turnstile 组件。
- `API key 环境变量` 填 `CAPTCHA_2CAPTCHA_API_KEY`，不能填密钥本身。密钥只保存在服务器受限环境文件中，后台不会显示或返回密钥。
- `Turnstile site key` 填组件的公开 sitekey，而非 Cloudflare secret key。
- 验证页面填上游路径（例如 `/login`），不要加代理前缀 `/666`。
- 默认超时 120 秒；每站点每小时最多 3 个任务，可设为 1–20。建议首次联调先设 1。
- 「检查已保存的验证码配置」仅检查密钥是否已加载、预算存储是否健康及本小时计数，不创建任务、不扣验证码费用。

本机安全配置服务器密钥（已有 `ops/.env` SSH 配置时）：

```powershell
python ops/configure-captcha.py
python deploy-current-fix.py
```

第一条命令通过不回显提示接收 API key，写入 `/etc/iframe-host/secrets/2captcha.env`（root:root，0600），并创建 systemd drop-in `/etc/systemd/system/iframe-host.service.d/30-captcha.conf`。脚本不修改站点开关、不创建任务；需要重启服务才生效。`--stdin` 仅供安全自动化内存传递，禁止将密钥写进命令行参数或 shell 历史。

Linux 服务通过直连访问 `https://api.2captcha.com`，不使用 Windows 工作站代理。预算文件为 `/var/lib/iframe-host/captcha-budget.json`，由服务账户写入。丢失预算文件会重置计数，不应当作日常清理文件；损坏或写入失败时停止新任务。单进程内去重，当前实现不支持多个服务进程共享预算文件。

开启后，原生优先模式先等待 10 秒，尚未成功才尝试付费兜底；仅服务商模式立即开始。一个页面最多发起一次任务；失败不自动重新创建任务，刷新页面可能再次消耗额度。额度在调用供应商之前持久化，网络失败也计入本地限额；此计数不是供应商实际账单。每站最多一个活动任务。

页面票据绑定站点配置及 HttpOnly 浏览器 Cookie，5 分钟过期。取得结果后写入响应字段并回调原站组件，不会伪造后端验证成功，不会向打码商发送用户密码，也不会导入或共享登录态。不要将启用服务的页面放入公共缓存。

不支持整页 Cloudflare 挑战、含 cData/chlPageData 的组件、隐式组件或验证脚本根本无法加载的情况。只使用 `getResponse()` 取值时需配置响应字段名或选择器并发生匹配的显式 render。修改 hostname、删除 div 或启用按钮不能保证后端接受验证。拿到 token 不代表登录成功，必须以实际登录接口结果验证兼容性。

联调先运行 `npm run check` 和 `node test-multisite-integration.js`（供应商模拟，不扣费），再检查后台状态。真实付费联调应明确确认次数，使用本人测试账号；不要输出 API key、完整验证码结果或 Authorization。关闭站点验证码服务即可停止后续新任务；已经提交供应商的任务不会被撤回。

### 验证码兼容模式与自定义适配

后台「编辑站点 → 验证码服务」新增兼容模式：

- `native_first`（默认）：原生优先，等待 10 秒后尝试服务商。真实打码结果有效期间，不让原控件的错误/超时/过期/不支持回调覆盖成功状态。
- `provider_only`（仅服务商验证 / 强制兼容）：只对匹配页面、sitekey 的显式组件跳过原生 render，立即请求服务商。不再显示该组件的原生报错框，保留应用原有成功回调。不是修改后端验证、伪造 token 或强制启用登录按钮；需要原生 API 脚本可加载及应用执行显式 render。

适配字段（通常全部留空即可）：

| 配置键 | 用法 |
| --- | --- |
| `response_selector` | CSS 选择器，指向已存在的隐藏/文本 input 或 textarea，可匹配多个；例如 `input[name="cf-turnstile-response"]` 或 `#captcha-token`。不是外层 div。无效或找不到字段时不创建任务。 |
| `response_field_name` | 自动创建/寻找隐藏 input 的 name，默认沿用组件 `response-field-name` 或 `cf-turnstile-response`。配置 selector 时以 selector 为准。 |
| `callback_path` | 额外的已有全局函数路径，如 `app.onVerified`；接收真实 token 并保留函数 this，不接受任意 JS。组件的原有回调仍会执行，Vue/React 内部闭包无需手动填写路径。 |
| `result_ttl_seconds` | 本地结果有效期上限，默认 120 秒，可设 30–240 秒。不能延长服务商/上游实际有效期，且 token 只能按上游规则使用。 |

匹配组件的 `getResponse`/`isExpired` 一并适配；reset/remove/页面卸载及本地过期都会清空缓存结果。过期和 reset 通知原过期回调，状态文字同步更新；不会自动创建第二个付费任务。不得仅凭隐藏 input 有值判断登录成功，必须以应用正常提交和后端结果为准。不支持任意验证码类型的自动转换，也不做账号密码抓取或自动登录。

`/666` 实测还需要 SPA 路由基路径适配：当前上游构建含 `history:qr("/")`，站点 literal 替换为 `history:qr("/666/")` 后才会停留在正确登录路由。此规则是特定构建的站点配置，不是通用编译产物规则；上游升级后需要重新核对，不能声称对所有 Vue 站点自动适配。

## 本机 SSH 配置

```powershell
Copy-Item iframe-host\ops\.env.example iframe-host\ops\.env
# 编辑 .env 填入 host/user/password
python iframe-host\ops\diagnostics\inspect-routing.py
python iframe-host\deploy-current-fix.py
```

不要把密码写进会被 Git 跟踪的脚本。

## 部署

```powershell
# 本地校验
npm --prefix iframe-host run check
node test-multisite-integration.js

# 上传并重启
python iframe-host/deploy-current-fix.py
```

生产应用目录：`/opt/iframe-host`  
配置：`/etc/iframe-host/config.production.json`  
服务：`systemctl restart iframe-host`

## 历史脚本说明

仓库根目录和 `iframe-host/` 下有很多旧诊断/修复脚本（`check-*.py`、`debug-nginx.py` 等）。

- **没有发现内容完全相同的重复脚本**，但功能高度重叠。
- 其中不少针对旧的单站点逻辑或错误的 `proxy_pass .../` 写法，**不能直接对生产执行**。
- 新的权威入口：`iframe-host/ops/` + `iframe-host/deploy-current-fix.py`。
- 旧脚本先保留不删，避免丢失历史排查线索；需要时再逐个归档。
