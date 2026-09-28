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

在应用右上角打开 **AI 设置**，填写自己的 API Key、模型和兼容 Chat Completions 的 HTTPS 接口地址。默认接口地址为 `https://api.openai.com/v1/chat/completions`。密钥只在当前窗口内存中使用，不写入行程文件或本地存储。行程与规划条件保存在当前设备的 WebView 本地存储中。

AI 生成的营业时间、费用、预约和交通细节可能不准确。天气预报来自 Open-Meteo，通常只能查询未来 16 天。出行前应核对场所官方渠道。活动费用汇总不包括未列出的住宿与大交通。

## GitHub 一键发布

将项目推送到自己的 GitHub 仓库后，在 **Actions → Publish Windows release → Run workflow** 点击运行。工作流会构建 Windows NSIS 安装包，并在 **Releases** 中创建 `v0.1.0` 版本。

再次发布前，同步修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本号。未签名安装包在部分 Windows 设备上可能触发 SmartScreen 提示；正式对外发布建议配置代码签名。

## 技术栈

Tauri 2、React 19、TypeScript、Rust、Open-Meteo。
