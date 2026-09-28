use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannerRequest {
    destination: String,
    start_date: String,
    days: u8,
    travelers: u8,
    budget: f64,
    pace: String,
    interests: Vec<String>,
    notes: String,
}

#[tauri::command]
async fn generate_trip(
    api_key: String,
    endpoint: String,
    model: String,
    request: PlannerRequest,
) -> Result<String, String> {
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "接口地址无效".to_string())?;
    if url.scheme() != "https" {
        return Err("接口地址必须使用 HTTPS".into());
    }
    if api_key.trim().is_empty() || model.trim().is_empty() {
        return Err("请填写 API Key 和模型".into());
    }
    if request.destination.trim().is_empty() || request.days == 0 || request.days > 14 {
        return Err("目的地或旅行天数无效".into());
    }

    let system = r#"你是一位审慎的中文旅行规划助手。只返回一个 JSON 对象，不要 Markdown 或额外文字。
JSON 格式必须为：{"title":"标题","destination":"目的地","overview":"简述","days":[{"date":"YYYY-MM-DD","theme":"当日主题","activities":[{"time":"HH:MM","title":"活动","detail":"实际安排与提醒","location":"可搜索的地点","estimatedCost":0,"durationMinutes":60,"type":"类别"}]}],"tips":["提示"]}。
days 的数量必须等于旅行天数，日期从出发日期逐日递增。estimatedCost 是所有同行者该项活动的人民币费用估算，只能是数字。每项安排应符合时间与地理顺序，考虑交通和休息。不要声称已查到实时营业时间、票价、天气或预约余量；无法确定时写明需到官方渠道核对。不要编造引用链接。"#;
    let user = json!({
        "destination": request.destination,
        "startDate": request.start_date,
        "days": request.days,
        "travelers": request.travelers,
        "totalBudgetCny": request.budget,
        "pace": request.pace,
        "interests": request.interests,
        "notes": request.notes,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "无法初始化网络请求".to_string())?;
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user.to_string()}
            ],
            "temperature": 0.6
        }))
        .send()
        .await
        .map_err(|error| format!("连接 AI 服务失败：{error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "AI 服务返回了无法解析的响应".to_string())?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("请求失败");
        return Err(format!(
            "AI 服务返回 {status}：{}",
            message.chars().take(180).collect::<String>()
        ));
    }
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "AI 服务未返回行程内容".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![generate_trip])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
