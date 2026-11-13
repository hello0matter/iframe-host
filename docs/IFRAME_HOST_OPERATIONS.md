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
