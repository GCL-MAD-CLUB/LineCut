use tauri::Manager;

mod backend;
mod error;
mod identity;
mod models;
mod project_file;

use backend::*;
use error::*;
use models::*;

const HEAD_TAIL_HASH_BYTES: u64 = 1024 * 1024;
const FFMPEG_PROGRESS_EVENT: &str = "ffmpeg-progress";
const PROXY_FILE_NAME: &str = "proxy_preview_i.mp4";
const DEFAULT_FFMPEG_PROGRAM: &str = "ffmpeg";
const DEFAULT_FFPROBE_PROGRAM: &str = "ffprobe";
const PROJECT_FILE_EXTENSION: &str = "lcp";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migration_only = std::env::args_os().any(|arg| arg == "--migrate-legacy-data");
    if migration_only {
        let argument_path = |flag: &str| {
            std::env::args_os()
                .skip_while(|arg| arg != flag)
                .nth(1)
                .map(std::path::PathBuf::from)
        };
        let progress_file = argument_path("--migration-progress");
        let cancel_file = argument_path("--migration-cancel");
        if let Err(error) = identity::migrate_for_installer(progress_file.as_deref(), cancel_file) {
            if error.kind() != std::io::ErrorKind::Interrupted {
                app_error(
                    ErrorCode::ApplicationRunFailed,
                    format!("Failed to migrate application identity: {error}"),
                );
            }
            std::process::exit(if error.kind() == std::io::ErrorKind::Interrupted {
                2
            } else {
                1
            });
        }
        return;
    }
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_logging(app.handle())?;
            app.manage(AppState::new());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window
                    .set_theme(Some(tauri::Theme::Light))
                    .map_err(|error| {
                        app_error(
                            ErrorCode::WindowThemeFailed,
                            format!("Failed to apply the main window theme: {error}"),
                        )
                    })?;
                let hwnd = window.hwnd().map_err(|error| {
                    app_error(
                        ErrorCode::WindowHandleUnavailable,
                        format!("Failed to obtain the main window handle: {error}"),
                    )
                })?;
                install_system_file_drop(app.handle().clone(), hwnd)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            take_preferences_startup_error,
            take_launch_project_path,
            update_preferences,
            import_media,
            register_import_media,
            analyze_imported_media,
            find_media_needing_analysis,
            list_import_locations,
            list_import_directory,
            probe_import_preview,
            copy_import_media,
            get_cached_video_cover_thumbnail,
            cache_subtitle_thumbnail,
            get_cached_subtitle_thumbnails,
            generate_subtitle_thumbnails,
            cache_storyboard_thumbnail,
            get_cached_storyboard_thumbnails,
            generate_storyboard_thumbnails,
            storyboard_frame_trace,
            demux_media_streams,
            decode_audio_pcm_window,
            generate_proxy,
            export_clips,
            still_export_defaults,
            export_still_frame,
            add_external_subtitles,
            save_project_file,
            auto_save_project_snapshot,
            open_project_file,
            recent_project_sizes,
            sync_project_workspace,
            close_project,
            path_is_file,
            path_is_directory,
            list_media_link_files,
            probe_media_link_files,
            list_media_browser_directory,
            media_browser_icon,
            media_browser_frame,
            list_media_browser_roots,
            resolve_known_folder,
            load_workspace_config,
            save_workspace_config,
            load_import_browser_config,
            update_import_browser_config,
            load_project_states,
            save_project_state,
            save_project_panel_state,
            prune_project_states,
            detect_storyboard_shots,
            storyboard_semantic_search_available,
            initialize_storyboard_semantic_search,
            select_storyboard_frames,
            search_storyboards_semantic,
            semantic_search_available,
            search_subtitles_semantic,
            index_subtitles_semantic,
            set_media_import_drop_region,
            reveal_in_file_manager,
            open_user_guide,
            open_log_directory,
            cancel_task,
            play_system_sound,
            record_frontend_incident
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                let _ = cancel_all_tasks(state.inner());
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        app_error(
            ErrorCode::ApplicationRunFailed,
            format!("Application event loop failed: {error}"),
        );
    }
}
