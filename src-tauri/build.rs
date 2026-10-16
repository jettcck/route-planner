fn main() {
    // Optimization alone does not switch Tauri into production mode.
    // Refuse Android release libraries that would load the dev server.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
        && std::env::var("PROFILE").as_deref() == Ok("release")
        && tauri_build::is_dev()
    {
        panic!("Android release builds require tauri/custom-protocol to embed frontendDist");
    }
    // map-launcher / android-updater 都是定义在本应用内的「内联插件」。
    // Tauri v2 的 ACL 对插件命令一律生效：若不为插件登记权限清单，
    // 前端 invoke("plugin:<名>|...") 会被直接拒绝，
    // 且拒绝只回传给 JS 的 Promise、不写 logcat，极易被误判成「功能没生效」。
    //
    // 历史问题：android-updater 一直没在这里登记，导致
    // App.tsx 的 invoke("plugin:android-updater|check") 从未真正执行过
    // （被 .catch(() => {}) 吞掉），自更新检查形同虚设。
    //
    // commands(...) 按命令名自动生成 allow-/deny- 权限；
    // default_permission(AllowAllCommands) 生成 default 权限集，
    // 供 capabilities/default.json 以 "<插件名>:default" 引用。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "map-launcher",
                tauri_build::InlinedPlugin::new()
                    .commands(&["open_map", "map_apps"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "android-updater",
                tauri_build::InlinedPlugin::new()
                    .commands(&["check", "install"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "secure-storage",
                tauri_build::InlinedPlugin::new()
                    .commands(&["secure_set", "secure_get", "secure_delete"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "file-share",
                tauri_build::InlinedPlugin::new()
                    .commands(&["share_text"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "notifications",
                tauri_build::InlinedPlugin::new()
                    .commands(&[
                        "schedule_notification",
                        "cancel_notification",
                        "cancel_all_notifications",
                    ])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "weather-background",
                tauri_build::InlinedPlugin::new()
                    .commands(&[
                        "schedule_weather_monitor",
                        "cancel_weather_monitor",
                        "weather_monitor_status",
                    ])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "location-permission",
                tauri_build::InlinedPlugin::new()
                    .commands(&["request_location_permission", "location_permission_status"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            ),
    )
    .expect("failed to run tauri-build");
}
