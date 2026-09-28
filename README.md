# 途迹 Route

一个以行程规划为核心的 Tauri 桌面应用。输入目的地、日期、预算和偏好后，可使用兼容 Chat Completions 的 AI 服务生成逐日攻略，并在本机编辑、打印或导出 JSON。

## 本地运行

需要 Node.js 24+、Rust、Windows WebView2 开发环境。

```powershell
npm install
npm run tauri dev
```

仅查看界面可运行 `npm run dev`，浏览器版不支持 AI 生成功能。`npm run build` 用于检查前端构建；`npm run tauri build` 构建桌面安装包。

## AI 设置

在应用右上角打开 **AI 设置**，可选择 OpenAI、DeepSeek、智谱 AI、通义千问、Moonshot/Kimi、SiliconFlow 或自定义兼容服务。选择预置服务商后，接口地址和常用模型会自动填写；自定义服务需要填写兼容 Chat Completions 的 HTTPS 接口地址。密钥只在当前窗口内存中使用，不写入行程文件或本地存储。行程与规划条件保存在当前设备的 WebView 本地存储中。

AI 生成的营业时间、费用、预约和交通细节可能不准确。天气预报来自 Open-Meteo，通常只能查询未来 16 天。出行前应核对场所官方渠道。活动费用汇总不包括未列出的住宿与大交通。

## GitHub 一键发布

将项目推送到自己的 GitHub 仓库后，在 **Actions → Publish desktop and Android release → Run workflow** 点击运行。工作流会构建 Windows NSIS 安装包和 ARM64 Android APK，并把两者上传到同一个 **Release**。

首次安装 `v0.2.0` 后，桌面端和 Android 端都会在启动时检查 GitHub Releases。Windows 发现新版本时会下载签名包并自动重启；Android 会下载匹配包名、版本号和已安装签名的 APK，然后打开系统安装器，用户确认后完成更新。Android 无法静默替换自身；首次从历史 debug APK 切换到正式签名 APK 时，需要先卸载旧 debug 版本。

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
