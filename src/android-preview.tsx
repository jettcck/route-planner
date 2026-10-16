import { useState } from "react";
import "./android-preview.css";

/** The preview embeds the real application at a phone-sized viewport. */
export default function AndroidPreviewPage() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <main className="preview-page preview-page--real">
      <header className="preview-toolbar">
        <div>
          <span>途迹 ROUTE · ANDROID PREVIEW</span>
          <h1>安卓端 1:1 界面预览</h1>
          <p>手机屏幕内加载的是项目当前真实 App 页面，和安卓构建共用同一套 React、样式、启动页与登录逻辑。</p>
        </div>
        <div className="preview-toolbar-actions">
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重新打开</button>
          <a href="/">返回项目</a>
          <a href="/android-test">原生诊断</a>
        </div>
      </header>
      <div className="preview-stage">
        <div className="phone-device phone-device--real" aria-label="途迹安卓真实界面模拟器">
          <div className="phone-camera" />
          <iframe key={reloadKey} className="phone-screen-frame" title="途迹安卓端真实界面" src="/?android-embedded=1" />
        </div>
        <aside className="preview-notes">
          <div className="preview-note"><b>真实页面</b><span>不是截图或静态示意，iframe 里运行的是当前项目真实 App。</span></div>
          <div className="preview-note"><b>真实交互</b><span>可以直接操作启动页、登录页、表单、行程、天气和底部导航。</span></div>
          <div className="preview-note"><b>实时同步</b><span>修改 App.tsx 或 App.css 后，刷新此页面即可看到最新安卓端界面。</span></div>
          <div className="preview-note preview-note--tip"><b>说明</b><span>浏览器预览没有 Tauri 原生容器，所以地图、通知、更新等原生能力会显示降级提示；视觉和前端交互仍是真实版本。</span></div>
        </aside>
      </div>
    </main>
  );
}
