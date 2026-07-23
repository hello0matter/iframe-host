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
4. 审计探针默认关；开启后会有限保存请求/响应正文，仅排障时使用。

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
