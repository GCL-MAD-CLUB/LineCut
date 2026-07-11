use super::*;

pub(crate) async fn export_one_range(
    input_path: &str,
    range: &ClipRange,
    mode: &ExportMode,
    has_source_audio: bool,
    bound_media: &[ExportBoundMedia],
    output_path: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> Result<(), String> {
    let duration_us = range.end_us.saturating_sub(range.start_us).max(1);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        seconds_arg(range.start_us),
        "-i".to_string(),
        input_path.to_string(),
    ];

    let mut audio_input_indexes = Vec::new();
    let mut subtitle_input_indexes = Vec::new();
    for media in bound_media {
        args.extend([
            "-ss".to_string(),
            seconds_arg(range.start_us),
            "-i".to_string(),
            media.path.clone(),
        ]);
        let input_index = audio_input_indexes.len() + subtitle_input_indexes.len() + 1;
        match media.kind {
            ExportBoundMediaKind::Audio => audio_input_indexes.push(input_index),
            ExportBoundMediaKind::Subtitle => subtitle_input_indexes.push(input_index),
        }
    }

    args.extend(["-t".to_string(), seconds_arg(duration_us)]);

    args.extend(["-map".to_string(), "0:v:0".to_string()]);
    let should_mix_audio = !audio_input_indexes.is_empty();
    if should_mix_audio {
        let mut audio_inputs = Vec::new();
        if has_source_audio {
            audio_inputs.push("[0:a:0]".to_string());
        }
        audio_inputs.extend(
            audio_input_indexes
                .iter()
                .map(|index| format!("[{index}:a:0]")),
        );
        args.extend([
            "-filter_complex".to_string(),
            format!(
                "{}amix=inputs={}:duration=first:dropout_transition=0:normalize=1[aout]",
                audio_inputs.join(""),
                audio_inputs.len()
            ),
            "-map".to_string(),
            "[aout]".to_string(),
        ]);
    } else if has_source_audio {
        args.extend(["-map".to_string(), "0:a:0?".to_string()]);
    }
    for input_index in &subtitle_input_indexes {
        args.extend(["-map".to_string(), format!("{input_index}:s:0?")]);
    }

    match mode {
        ExportMode::FastCopy => {
            args.extend([
                "-c:v".to_string(),
                "copy".to_string(),
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
            ]);
            if has_source_audio || should_mix_audio {
                args.extend([
                    "-c:a".to_string(),
                    if should_mix_audio { "aac" } else { "copy" }.to_string(),
                ]);
            }
            if !subtitle_input_indexes.is_empty() {
                args.extend(["-c:s".to_string(), "copy".to_string()]);
            }
        }
        ExportMode::PreciseEncode => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
                "-movflags".to_string(),
                "+faststart".to_string(),
            ]);
            if !subtitle_input_indexes.is_empty() {
                args.extend(["-c:s".to_string(), "mov_text".to_string()]);
            }
        }
    }

    args.push(output_path.to_string_lossy().into_owned());
    let program = ffmpeg_program(preferences);
    if let Some(progress) = progress {
        run_status_with_ffmpeg_progress(&program, &args, progress).await
    } else {
        run_status(&program, &args).await
    }
}

pub(crate) async fn concat_segments(
    parts: &[PathBuf],
    output_path: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> Result<(), String> {
    let list_path = output_path.with_extension("concat.txt");
    if let Some(context) = &progress {
        register_task_cleanup_paths(
            context.task_id,
            std::slice::from_ref(&list_path),
            context.state,
        )?;
    }
    if let Some(cancel) = progress.as_ref().map(|context| context.cancel.clone()) {
        let parts = parts.to_vec();
        let path = list_path.clone();
        spawn_blocking_cancellable(cancel, "写入合并列表", move |cancel| {
            let mut body = String::new();
            for part in parts {
                ensure_not_cancelled(cancel)?;
                let normalized = part
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''");
                body.push_str(&format!("file '{normalized}'\n"));
            }
            fs::write(path, body).map_err(|e| format!("写入合并列表失败: {e}"))
        })
        .await?;
    } else {
        let mut body = String::new();
        for part in parts {
            let normalized = part
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', "'\\''");
            body.push_str(&format!("file '{normalized}'\n"));
        }
        fs::write(&list_path, body).map_err(|e| format!("写入合并列表失败: {e}"))?;
    }
    let args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().into_owned(),
        "-c".to_string(),
        "copy".to_string(),
        output_path.to_string_lossy().into_owned(),
    ];
    let program = ffmpeg_program(preferences);
    let result = if let Some(progress) = progress {
        run_status_with_ffmpeg_progress(&program, &args, progress).await
    } else {
        run_status(&program, &args).await
    };
    if result.is_ok() {
        remove_cleanup_paths_async(vec![list_path]).await;
    }
    result
}

pub(crate) fn build_clip_plan(
    cues: &[SubtitleCue],
    head_padding_us: i64,
    tail_padding_us: i64,
    merge_gap_us: i64,
    duration_us: i64,
) -> Vec<ClipRange> {
    let mut ranges = cues
        .iter()
        .map(|cue| ClipRange {
            index: 0,
            start_us: (cue.start_us - head_padding_us).max(0),
            end_us: if duration_us > 0 {
                (cue.end_us + tail_padding_us).min(duration_us)
            } else {
                cue.end_us + tail_padding_us
            },
            cue_ids: vec![cue.id.clone()],
            head_padding_us,
            tail_padding_us,
        })
        .filter(|range| range.end_us > range.start_us)
        .collect::<Vec<_>>();

    ranges.sort_by_key(|range| range.start_us);

    let mut merged: Vec<ClipRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start_us <= last.end_us + merge_gap_us {
                last.end_us = last.end_us.max(range.end_us);
                last.cue_ids.extend(range.cue_ids);
                continue;
            }
        }
        merged.push(range);
    }

    for (index, range) in merged.iter_mut().enumerate() {
        range.index = index;
    }

    merged
}

pub(crate) fn seconds_arg(us: i64) -> String {
    let value = us.max(0);
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}

pub(crate) fn display_time(us: i64) -> String {
    let total_ms = us.max(0) / 1000;
    let ms = total_ms % 1000;
    let total_seconds = total_ms / 1000;
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{ms:03}")
}

pub(crate) fn file_time_label(us: i64) -> String {
    display_time(us).replace(':', "-").replace('.', "-")
}

pub(crate) fn export_file_stem(
    rule: ExportNameRule,
    source_stem: &str,
    range: &ClipRange,
    cue_lookup: &HashMap<&str, &SubtitleCue>,
    dialogue_line_indexes: &[usize],
) -> String {
    let time_range = format!(
        "{}-{}",
        file_time_label(range.start_us),
        file_time_label(range.end_us)
    );
    let dialogue = quoted_dialogue_for_range(range, cue_lookup, dialogue_line_indexes);
    let raw = match rule {
        ExportNameRule::SourceTimeRange => format!("{source_stem}_{time_range}"),
        ExportNameRule::SourceDialogue => format!("{source_stem}_{dialogue}"),
        ExportNameRule::TimeRange => time_range,
        ExportNameRule::Dialogue => dialogue,
    };
    safe_component(&raw)
}

pub(crate) fn effective_export_name_rule(
    rule: ExportNameRule,
    layout: &ExportLayout,
) -> ExportNameRule {
    match (layout, rule) {
        (ExportLayout::Merged, ExportNameRule::SourceDialogue) => ExportNameRule::SourceTimeRange,
        (ExportLayout::Merged, ExportNameRule::Dialogue) => ExportNameRule::TimeRange,
        _ => rule,
    }
}

pub(crate) fn quoted_dialogue_for_range(
    range: &ClipRange,
    cue_lookup: &HashMap<&str, &SubtitleCue>,
    dialogue_line_indexes: &[usize],
) -> String {
    let selected_lines = dialogue_line_indexes
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let use_all_lines = selected_lines.is_empty();
    let text = range
        .cue_ids
        .iter()
        .filter_map(|id| cue_lookup.get(id.as_str()))
        .flat_map(|cue| dialogue_lines_for_cue(cue, &selected_lines, use_all_lines))
        .collect::<Vec<_>>()
        .join(" ");
    let text = collapse_filename_text(&text);
    if text.is_empty() {
        format!("“{}”", file_time_label(range.start_us))
    } else {
        format!("“{text}”")
    }
}

pub(crate) fn dialogue_lines_for_cue<'a>(
    cue: &'a SubtitleCue,
    selected_lines: &HashSet<usize>,
    use_all_lines: bool,
) -> Vec<&'a str> {
    let lines = cue
        .plain_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if use_all_lines {
        return lines;
    }

    let selected = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| selected_lines.contains(&index).then_some(*line))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        lines
    } else {
        selected
    }
}

pub(crate) fn collapse_filename_text(value: &str) -> String {
    let whitespace_re = Regex::new(r"\s+").expect("valid whitespace regex");
    let mut text = whitespace_re.replace_all(value.trim(), " ").into_owned();
    text = text
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    truncate_chars(text.trim(), 80)
}

pub(crate) fn unique_output_path(
    dir: &Path,
    file_stem: &str,
    ext: &str,
    used_names: &mut HashSet<String>,
) -> PathBuf {
    let base = if file_stem.trim().is_empty() {
        "clip".to_string()
    } else {
        file_stem.to_string()
    };
    for suffix in 0..10_000 {
        let name = if suffix == 0 {
            format!("{base}.{ext}")
        } else {
            format!("{base}_{suffix:02}.{ext}")
        };
        let lowered = name.to_ascii_lowercase();
        let candidate = dir.join(&name);
        if !used_names.contains(&lowered) && !candidate.exists() {
            used_names.insert(lowered);
            return candidate;
        }
    }
    dir.join(format!("{base}_{}.{}", now_millis(), ext))
}

pub(crate) fn safe_component(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    output = truncate_chars(&output, 120);
    output = output.trim().trim_matches('.').to_string();
    if output.trim().is_empty() {
        "clip".to_string()
    } else {
        output
    }
}

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}
