# Render 部署账号服务和 AI 代理

项目根目录的 `render.yaml` 已经准备好。它会创建一个 Render Web Service，并使用 Render 提供的免费 HTTPS 子域名，例如：

```text
https://route-planner-auth.onrender.com
```

部署步骤：

1. 把项目推送到 GitHub。
2. 打开 Render，选择 **New → Blueprint**，连接这个 GitHub 仓库。
3. 选择项目根目录中的 `render.yaml` 并创建服务。
4. Render 会提示填写 `AI_API_KEY`。在 Render 的 Secret 环境变量中填写，不要写入仓库。
5. 部署完成后打开：

   ```text
   https://你的服务名.onrender.com/readyz
   ```

   返回 `ok: true` 才算服务可接收流量。

6. 将完整服务地址设置为 GitHub Actions 的 **Variables → `VITE_AUTH_ENDPOINT`**，例如：

   ```text
   https://route-planner-auth.onrender.com
   ```

7. 重新运行 Android 发布工作流，生成的 APK 才会指向 Render 服务。已经生成的本地 APK 仍然指向本地联调地址。

## Render 免费计划的限制

免费 Web Service 会休眠，首次访问可能需要等待几十秒；它的本地文件系统也不是持久存储。当前账号服务使用 JSON 文件保存账号，因此免费服务重启或重新部署后可能丢失账号数据。

要长期保存账号，需要为 Render 服务添加付费持久磁盘，或把账号库迁移到外部数据库（例如 Supabase/Postgres）。在完成迁移前，不要把这个免费实例当作正式生产账号库。

当前生产环境没有邮件服务配置，因此生产环境的“忘记密码”会提示邮件验证未配置；本地开发验证码不会在生产环境开放。

## 安全边界

- `AI_API_KEY` 只放 Render Secret，不放 GitHub Variables、前端构建变量或 APK。
- `AUTH_ORIGINS` 默认只允许 Android/Tauri 的 `https://tauri.localhost` 来源。
- Render 的免费子域名已经提供 HTTPS，不需要购买自己的域名。
