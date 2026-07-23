# iframe-host 运维脚本（统一放在本目录）

## SSH 本机凭证怎么配

1. 复制模板：
   ```powershell
   Copy-Item iframe-host\ops\.env.example iframe-host\ops\.env
   ```
2. 编辑 `iframe-host/ops/.env`：
   ```env
   IFRAME_HOST=50.114.113.121
   IFRAME_SSH_USER=root
   IFRAME_SSH_PASSWORD=你的服务器密码
   IFRAME_SSH_PORT=22
   ```
3. `.env` 已被 `.gitignore` 忽略，不会提交到 Git。

也可用密钥：
```env
IFRAME_SSH_KEY_FILE=C:\Users\你\.ssh\id_ed25519
```

## 常用命令（在仓库根目录执行）

```powershell
# 只读检查路由
python iframe-host/ops/diagnostics/inspect-routing.py

# 只读检查代理资源
python iframe-host/ops/diagnostics/inspect-proxy-assets.py

# 公共入口验证
python iframe-host/ops/verify/verify-public-routes.py

# 部署当前本地 server.js + admin.html 到生产
python iframe-host/deploy-current-fix.py
```

改生产 Nginx 的脚本默认 dry-run，需要显式 `--apply` 才会改。

## 为什么之前连不上

- Windows 自带 `ssh` 在本机会话里密码交互有时失败。
- 用 **Paramiko + 密码/.env** 可稳定连接（`deploy-with-password.py`、本目录脚本同一方式）。
- 不要把密码写进会被 Git 跟踪的 `.py` 文件。

## 目录说明

```
iframe-host/
  server.js                 # 生产 Node 服务源码
  public/admin.html         # 管理后台
  config.example.json
  check-config.js
  ops/                      # 运维工具（诊断/部署/验证）
    .env                    # 本机凭据（忽略，不提交）
    lib/remote.py
    diagnostics/
    deploy/
    verify/
  docs/IFRAME_HOST_OPERATIONS.md
  deploy-current-fix.py      # 一键上传当前 server+admin 并重启
```

历史零散诊断脚本（`check-css-chain.py`、`debug-nginx.py` 等）保留在原处，**不要直接对生产执行**；以 `ops/` 下脚本为准。
