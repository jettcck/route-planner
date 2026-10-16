# 途迹账号服务部署

这套模板把 Node 账号服务放在本机回环地址 `127.0.0.1:8787`，由 Caddy 负责 HTTPS。Caddy 会自动申请和续期证书，因此只需要一个已经解析到服务器的域名。账号库挂载到 `./data`，升级容器不会丢失用户数据。

部署前准备：

1. 一台长期在线的 Linux 主机，开放 TCP 80/443。
2. 一个指向该主机的域名，例如 `account.example.com`。
3. `deploy/auth.env`：复制 `auth.env.example`，填写生产 AI 配置和前端来源。不要提交这个文件。
4. 把 `Caddyfile` 中的域名替换成真实域名。

启动和检查：

```bash
cp deploy/auth.env.example deploy/auth.env
cp deploy/Caddyfile.example deploy/Caddyfile
# 编辑 deploy/auth.env 和 deploy/Caddyfile
docker compose -f deploy/docker-compose.yml up -d
curl --fail https://account.example.com/readyz
```

`/readyz` 返回 200 后，把同一个 HTTPS 根地址设置为 GitHub Actions Variable `VITE_AUTH_ENDPOINT`。AI Key 只放在 `deploy/auth.env` 或服务器的 Secret 管理器中，不放到仓库和前端构建变量里。

首次部署后应备份 `deploy/data/accounts.json` 和 `.bak`。更新服务使用 `docker compose pull && docker compose up -d`，数据卷不会被删除。
