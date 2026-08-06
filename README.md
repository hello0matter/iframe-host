# iframe-host

多站点 iframe/反向代理 + 管理后台 + 访客分析。

独立仓库；与 `crypto-arbitrage-bot-automated-trading` 无关。

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 配置本机 SSH（仅本地，不提交）
Copy-Item ops\.env.example ops\.env
# 编辑 ops\.env：IFRAME_HOST / IFRAME_SSH_USER / IFRAME_SSH_PASSWORD 或 IFRAME_SSH_KEY_FILE

# 3. 本地检查
npm run check
node test-multisite-integration.js

# 生成源站不可达时使用的 HTML/CSS/图片兜底缓存
npm run refresh-fallback-cache

# 4. 部署 iframe-host 到生产
python deploy-current-fix.py

# 5. 构建并部署 Java 管理前端（源码位于 iframe-host 外部）
Set-Location D:\tmp\rouyi-ui-admin-vue2-full
$env:NODE_OPTIONS='--openssl-legacy-provider'
npm run build:prod
Set-Location D:\tmp\anjian\pj\st\tmp\miansha\iframe-host
python ops\deploy\deploy-yudao-admin.py
```

## 目录

| 路径 | 说明 |
|------|------|
| `server.js` | 服务主程序 |
| `public/admin.html` | 管理后台 |
| `config.example.json` | 多站点配置示例 |
| `test-multisite-integration.js` | 多站点/审计/分析集成测试 |
| `ops/` | 诊断、部署、验证脚本 |
| `docs/IFRAME_HOST_OPERATIONS.md` | 生产架构与运维说明 |
| `deploy-current-fix.py` | 一键部署 server + admin |

## 生产要点

- Node: `127.0.0.1:3030`，目录 `/opt/iframe-host`
- 管理后台: `https://hacket.top/internal-content-admin/`
- 追踪端点: `POST /__ih/track`
- Java API: `/yudao-api/`（不要占用 `/`）
- Java 管理后台：`/yudao-admin/`
- 若依原生 API：`/admin-api/`（兼容旧前端构建）
- 根路径 `/` 保留给 iframe-host 代理站点

默认根站点的上游当前配置为 `https://www.libaisec.com`。如果根路径返回 `504`，先检查服务器到该上游的出站连通性；这与 `/yudao-api/` Java 路由无关。

## 安全

- **不要**提交 `ops/.env`、`config.json`、`config.production.json` 或任何真实密码
- 凭据只放在本机被 `.gitignore` 忽略的 `ops/.env`
