# 途迹 Route

一个以行程规划为核心的 Tauri 桌面应用。输入目的地、日期、预算和偏好后，可使用兼容 Chat Completions 的 AI 服务生成逐日攻略，并在本机编辑、打印或导出 JSON。

## 本地运行

需要 Node.js 24+、Rust、Windows WebView2 开发环境。

```powershell
npm install
npm run tauri dev
```

仅查看界面或调试登录流程可运行 `npm run dev`（会同时启动 Vite 和本地账号服务；若 8787 已有健康服务则自动复用）；总控退出时会在 Windows 上清理整个子进程树，避免旧服务残留占用 1420/8787；也可用 `npm run dev:frontend` 只启动网页。网页端登录后通过账号服务代理使用 AI，Tauri 桌面端和 Android 端也可直接使用本机配置的 AI。`npm run build` 用于检查前端构建；`npm run tauri build` 构建桌面安装包。

需要单独运行账号服务时：

```powershell
Copy-Item .env.example .env
npm run auth:dev
```

生产环境请设置 `AUTH_ORIGINS` 为实际网页域名（多个来源用英文逗号分隔）；Android/Tauri 原生页面如需访问同一服务，可额外保留精确的 `http://tauri.localhost` 或 `https://tauri.localhost` 来源，不能使用通配符或普通 localhost 地址。生产环境未显式设置 `AUTH_HOST` 时只监听 `127.0.0.1`，应通过 HTTPS 反向代理对外提供服务；服务响应会带 HSTS。开发环境默认监听 `0.0.0.0`，方便 Android 模拟器通过 `10.0.2.2` 联调。开发环境在未显式设置 `AUTH_ORIGINS` 时会允许 localhost/127.0.0.1 的任意端口，方便复用账号服务后切换 Vite 端口；一旦显式设置白名单则恢复精确匹配。并通过进程环境变量注入 AI Key。`GET /livez` 检查进程存活，`GET /healthz` 检查服务状态，`GET /readyz` 检查是否可以接收生产流量；服务端会限制登录和 AI 请求频率。
日志级别通过 `AUTH_LOG_LEVEL` 设置为 `silent`、`error`、`info` 或 `debug`；日志只包含请求元数据和请求 ID，不记录密码、Token、API Key 或请求体。

账号服务启动后可运行 `npm run auth:smoke`，自动检查健康状态、CORS 白名单、请求追踪 ID、JSON Content-Type、请求体大小限制及超大请求后的连接恢复、短信登录暂停状态、未授权 AI 请求拦截和登录锁定倒计时；smoke 默认使用临时端口和临时账号库，不会写入正在运行的开发账号数据，只有显式设置 `AUTH_SMOKE_URL` 时才连接外部服务。`npm run auth:transport-test` 会验证生产默认只监听回环地址并返回 HSTS；`npm run auth:client-test` 会验证客户端对慢响应、空 JSON 和超大响应的超时与格式保护；`npm run auth:routing-test` 会验证畸形 Host 和代理式请求目标不会触发 500 或让服务退出。
无需真实 Key 也可以运行 `npm run auth:ai-test`，它会用本地假 AI 上游验证注册、登录和 AI 代理的完整链路。
账号库恢复逻辑可用 `npm run auth:data-test` 验证；服务发现主文件损坏时会尝试恢复 `.bak`，两份都损坏则拒绝启动。
每个响应都会带 `X-Request-Id`；限流响应会带 `Retry-After`，线上排查时可把请求 ID 和时间交给服务端日志定位。
网页端会把 `Retry-After` 转成可读的等待提示，登录锁定和 AI 限流时不需要用户自行换算秒数。账号最多保留最近 5 个设备会话，新设备登录不会立即踢出其他设备；过期会话和验证码会在访问时清理并落盘。
用户中途关闭页面时，账号服务会取消尚未完成的上游 AI 请求，避免浪费模型额度和服务器连接。
部署前先运行 `npm run auth:config-check`。本地开发允许没有 AI Key；设置 `NODE_ENV=production` 后，缺少 AI Key、使用普通非 HTTPS 来源或使用通配符跨域都会直接检查失败，精确的 Tauri 应用来源除外。
日常提交前可直接运行 `npm run verify`，一次完成配置、账号接口、数据恢复、AI 代理、天气位置降级和前端构建验收；`npm run weather:resilience-test` 会验证当前位置天气请求失败时仍保留目的地预报。
发布前 `npm run release:check` 会校验桌面、Tauri 和 Android 版本号一致，并确认 Android versionCode 和发布工作流存在。
发布工作流会在验证和构建前运行 `npm run release:environment-check`，缺少生产 HTTPS 地址、Android 上传签名或 Tauri 更新签名时会立即失败；可用 `npm run release:environment-test` 在本地验证缺项检查不会输出密钥。
账号服务的 Docker/Caddy 部署模板位于 `deploy/`，可运行 `npm run deploy:config-test` 检查模板；它不会自动创建域名、服务器或云端密钥。
原生侧发布前运行 `npm run verify:native`，会执行 Rust 格式检查、Clippy 和全部测试目标。
Android 原生改动可运行 `npm run verify:android`，会编译 universal Debug 变体，覆盖 Kotlin、Manifest 和 Android 资源回归。更新规则测试代码位于 `src-tauri/gen/android/app/src/test`，可单独运行 `npm run verify:android:unit`；这不能代替真机安装、权限及后台运行验收。`/android-test` 诊断页和 `/android-preview` 安卓预览壳只在开发构建和 `npm run android:release:local` 的本地验收包中启用，GitHub 正式包会关闭两个入口并从前端资源中移除；构建结束会检查实际产物，防止误带测试界面。
Android 首页天气会先通过原生权限桥接申请粗略/精确定位，再由 WebView 的 `navigator.geolocation` 获取当前位置；用户拒绝定位时仍会回退到目的地天气，不会阻塞行程规划。真机或模拟器可打开 `/android-test`，在“定位权限”卡片检查权限状态并重新发起系统授权。
天气后台预警使用 WorkManager，并在设备重启、用户解锁、应用替换及系统时间变化后由原生广播重新注册；提醒数据则由 AlarmManager 持久化恢复。两者仍需在真机上验证厂商省电策略下的实际送达。
Android 单元测试在发布流水线固定使用 JDK 21；本地验收支持 JDK 21、25 或 26。Windows 中文工作区会自动使用 ASCII 临时工程入口和 Gradle 缓存目录，避免 Gradle 测试 worker 的类路径解析问题；其他 JDK 会提前提示配置 `JAVA_HOME`，不会把环境问题伪装成 Gradle 测试代码错误。
Windows 未启用开发者模式时，Tauri CLI 的默认 Android release 流程会因无法创建 Rust 原生库符号链接而失败。可使用 `npm run android:release:local`（PowerShell 先设置 `ANDROID_NDK_ROOT` 和 JDK 21）走文件复制回退路径；脚本默认编译 arm64-v8a、armeabi-v7a、x86 和 x86_64 四种 ABI，复制真实 `.so` 后再执行 Gradle、R8，并用本机 Debug keystore 签出可安装的测试 APK。该本地验收变体会临时允许模拟器通过 `10.0.2.2` 访问电脑上的 HTTP 账号服务；GitHub 正式包仍强制关闭明文流量。需要快速只编译 ARM64 时可设置 `ANDROID_TARGETS=aarch64`。这个签名只用于本地验收，不能替代生产上传密钥；GitHub Actions 使用正式 keystore 和 Linux runner，继续走标准 `tauri android build` 流程。

## AI 设置

Android 正式包不会预填本地开发账号服务地址。发布前请通过 `VITE_AUTH_ENDPOINT` 配置 HTTPS 账号服务地址，例如 `VITE_AUTH_ENDPOINT=https://account.example.com`；Debug 模拟器可填写 `http://10.0.2.2:8787`，Debug 真机可填写电脑局域网 IP（例如 `http://192.168.1.20:8787`）。`npm run android:release:local` 生成的本地验收包会自动预填模拟器地址 `http://10.0.2.2:8787`，并且只在诊断构建标记下临时允许该 HTTP 地址；Release 包强制 HTTPS。Android 上的账号会话和 AI Key 使用 Android Keystore 加密保存，导出的 JSON/CSV 通过系统分享面板交给用户保存。

Android 自更新会检查构建时注入的 GitHub 仓库。GitHub Actions 自动使用当前仓库；本地构建其他 fork 时设置 `ROUTE_ANDROID_UPDATE_REPOSITORY=owner/repository`，避免更新器误查原项目 Release。Windows 发布 job 也会在构建前把桌面更新端点切换到当前仓库。

在应用右上角打开 **AI 设置**，可选择 OpenAI、DeepSeek、智谱 AI、通义千问、Moonshot/Kimi、SiliconFlow 或自定义兼容服务。选择预置服务商后，接口地址和常用模型会自动填写；自定义服务需要填写兼容 Chat Completions 的 HTTPS 接口地址。Android 端的密钥会使用 Android Keystore 加密保存，桌面端和网页端只在当前窗口内存中使用，不写入本地存储或行程文件。行程与规划条件保存在当前设备的 WebView 本地存储中。

AI 生成的营业时间、费用、预约和交通细节可能不准确。天气预报来自 Open-Meteo，通常只能查询未来 16 天。出行前应核对场所官方渠道。活动费用汇总不包括未列出的住宿与大交通。

## GitHub 一键发布

将项目推送到自己的 GitHub 仓库后，在 **Actions → Publish desktop and Android release → Run workflow** 点击运行。工作流会构建 Windows NSIS 安装包和 Android APK，并把两者上传到同一个 **Release**。Android 更新器会优先选择 universal APK，并按设备 ABI 回退到 arm64-v8a 或 armeabi-v7a 包。
发布工作流默认只读，只有 Windows 和 Android 发布 job 申请 Release 写权限；同一 ref 会串行发布，构建超时会自动终止。Android job 结束时会清理上传 keystore、签名配置和临时 APK。 发布前置 validation job 会启动本地账号服务并运行网页、服务端、Rust 验收；Windows 和 Android 构建通过后才会上传 Release。

正式发布前，在 GitHub 仓库打开 **Settings → Secrets and variables → Actions → Variables**，新增 `VITE_AUTH_ENDPOINT`，值填写账号服务的 HTTPS 根地址，例如 `https://account.example.com`。Windows 和 Android job 会在构建前拒绝缺失、非 HTTPS、带凭据、查询参数或片段的地址，避免安装后的正式包无法登录。这个变量只保存服务地址；AI Key、数据库密码、Android keystore 和 updater 私钥仍必须放在 **Secrets** 中。

首次安装任意正式版本后，桌面端和 Android 端都会在启动时检查 GitHub Releases。Windows 发现新版本时会下载签名包并自动重启；Android 会下载匹配包名、版本号和已安装签名的 APK，然后打开系统安装器，用户确认后完成更新。Android 无法静默替换自身；首次从历史 debug APK 切换到正式签名 APK 时，需要先卸载旧 debug 版本。

发布新版本前，同步修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本号，并递增 `bundle.android.versionCode`。正式 Android 更新必须始终使用同一个上传密钥。

自动更新使用签名文件。仓库管理员需要在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加以下 Secret：

- `TAURI_SIGNING_PRIVATE_KEY`：updater 私钥文件的完整内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码；本项目当前密钥未设置密码，可留空

私钥只放在 GitHub Secret 中，不要提交到仓库。当前公钥已写入 `src-tauri/tauri.conf.json`，用于验证更新包。

Android 发布还需要在 GitHub Actions Secrets 中添加以下四项：

- `ANDROID_KEYSTORE_BASE64`：正式 Android keystore 文件的 Base64 内容
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码
- `ANDROID_KEY_ALIAS`：上传密钥别名
- `ANDROID_KEY_PASSWORD`：上传密钥密码

不要把 keystore、API Key 或任何密码提交到仓库。丢失 Android 上传密钥会导致后续 APK 无法覆盖已安装版本。

## 技术栈

Tauri 2、React 19、TypeScript、Rust、Open-Meteo。
