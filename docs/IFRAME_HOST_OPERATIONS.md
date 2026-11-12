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

- 管理后台右上角的 **中文 / English** 按钮可切换整个后台界面语言；登录页也提供同样的切换按钮。
- 选择结果保存在当前浏览器的 `localStorage`（键 `proxyAdminLang`），刷新或重新登录后保持。
- 也可以在 **全局设置 → 界面语言** 中切换，效果相同。
- 后台新增 **帮助** 标签页，包含快速开始、替换规则说明（普通文本 / 正则）、常见修改示例、排错和安全提示。
- 语言切换只影响管理后台界面，不会改变被代理站点的页面内容。

## 站点 URL 拦截脚本

- 每个站点可在「编辑站点 → URL 拦截脚本」中单独开启，支持普通文本或正则匹配。
- 请求命中规则后，代理不会访问上游，而是直接在 Node 进程内执行配置的 JavaScript，并返回脚本生成的结果。
- `request` 提供 `method`、`path`、`query`、`url`、`headers`、`cookies`、`body`；`site` 提供当前站点信息；`console.log` 输出到服务日志。
- 脚本需同步执行，返回字符串，或 `{ status, headers, body, content_type }`；默认超时 1000ms，可配置 50–5000ms。
- 拦截脚本属于管理员可信代码，仅在明确需要替换上游响应时开启；关闭开关后立即恢复为正常代理。

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
