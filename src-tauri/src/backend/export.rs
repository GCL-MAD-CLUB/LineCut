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
) -> AppResult<()> {
    let args = build_export_args(
        input_path,
        range,
        mode,
        has_source_audio,
        bound_media,
        output_path,
    )?;
    let program = ffmpeg_program(preferences);
    if let Some(progress) = progress {
        run_status_with_ffmpeg_progress(&program, &args, progress).await
    } else {
        run_status(&program, &args).await
    }
}

fn build_export_args(
    input_path: &str,
    range: &ClipRange,
    mode: &ExportMode,
    has_source_audio: bool,
    bound_media: &[ExportBoundMedia],
    output_path: &Path,
) -> AppResult<Vec<String>> {
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

    let mut audio_stream_specs = Vec::new();
    let mut subtitle_stream_specs = Vec::new();
    let mut next_input_index = 1usize;
    let mut additional_input_indexes = HashMap::new();
    for media in bound_media {
        if media.path.trim().is_empty() {
            return Err(app_error(
                ErrorCode::ExportBoundMediaInvalid,
                "Bound media source path is empty",
            ));
        }
        let stream_spec = match media.source {
            ExportBoundMediaSource::EmbeddedStream if media.path == input_path => {
                let stream_index = media.stream_index.ok_or_else(|| {
                    app_error(
                        ErrorCode::ExportBoundMediaInvalid,
                        "Embedded media stream index is missing",
                    )
                })?;
                format!("0:{stream_index}")
            }
            ExportBoundMediaSource::EmbeddedStream => {
                let stream_index = media.stream_index.ok_or_else(|| {
                    app_error(
                        ErrorCode::ExportBoundMediaInvalid,
                        "Embedded media stream index is missing",
                    )
                })?;
                let input_index = *additional_input_indexes
                    .entry(media.path.clone())
                    .or_insert_with(|| {
                        let input_index = next_input_index;
                        next_input_index += 1;
                        args.extend([
                            "-ss".to_string(),
                            seconds_arg(range.start_us),
                            "-i".to_string(),
                            media.path.clone(),
                        ]);
                        input_index
                    });
                format!("{input_index}:{stream_index}")
            }
            ExportBoundMediaSource::File => {
                let input_index = *additional_input_indexes
                    .entry(media.path.clone())
                    .or_insert_with(|| {
                        let input_index = next_input_index;
                        next_input_index += 1;
                        args.extend([
                            "-ss".to_string(),
                            seconds_arg(range.start_us),
                            "-i".to_string(),
                            media.path.clone(),
                        ]);
                        input_index
                    });
                match media.kind {
                    ExportBoundMediaKind::Audio => format!("{input_index}:a:0"),
                    ExportBoundMediaKind::Subtitle => format!("{input_index}:s:0"),
                }
            }
        };
        match media.kind {
            ExportBoundMediaKind::Audio => audio_stream_specs.push(stream_spec),
            ExportBoundMediaKind::Subtitle => subtitle_stream_specs.push(stream_spec),
        }
    }

    args.extend(["-t".to_string(), seconds_arg(duration_us)]);

    args.extend(["-map".to_string(), "0:v:0".to_string()]);
    let has_bound_audio = !audio_stream_specs.is_empty();
    if has_source_audio {
        audio_stream_specs.insert(0, "0:a:0".to_string());
    }
    let has_audio = !audio_stream_specs.is_empty();
    if has_bound_audio {
        let mut audio_filters = audio_stream_specs
            .iter()
            .enumerate()
            .map(|(index, stream)| {
                format!("[{stream}]aresample=async=1:first_pts=0[export_audio_{index}]")
            })
            .collect::<Vec<_>>();
        let audio_inputs = (0..audio_stream_specs.len())
            .map(|index| format!("[export_audio_{index}]"))
            .collect::<Vec<_>>();
        audio_filters.push(format!(
            "{}amix=inputs={}:duration=longest:dropout_transition=0:normalize=1[aout]",
            audio_inputs.join(""),
            audio_inputs.len()
        ));
        args.extend([
            "-filter_complex".to_string(),
            audio_filters.join(";"),
            "-map".to_string(),
            "[aout]".to_string(),
        ]);
    } else if let Some(stream) = audio_stream_specs.first() {
        args.extend(["-map".to_string(), format!("{stream}?")]);
    }
    for stream in &subtitle_stream_specs {
        args.extend(["-map".to_string(), stream.clone()]);
    }

    match mode {
        ExportMode::FastCopy => {
            args.extend([
                "-c:v".to_string(),
                "copy".to_string(),
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
            ]);
            if has_audio {
                args.extend([
                    "-c:a".to_string(),
                    if has_bound_audio { "aac" } else { "copy" }.to_string(),
                ]);
            }
            if !subtitle_stream_specs.is_empty() {
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
            if !subtitle_stream_specs.is_empty() {
                args.extend(["-c:s".to_string(), "mov_text".to_string()]);
            }
        }
    }

    args.push(output_path.to_string_lossy().into_owned());
    Ok(args)
}

pub(crate) async fn concat_segments(
    parts: &[PathBuf],
    output_path: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> AppResult<()> {
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
        spawn_blocking_cancellable(cancel, "write merge list", move |cancel| {
            let mut body = String::new();
            for part in parts {
                ensure_not_cancelled(cancel)?;
                let normalized = part
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''");
                body.push_str(&format!("file '{normalized}'\n"));
            }
            fs::write(path, body).map_err(|error| {
                app_error(
                    ErrorCode::ExportWriteFailed,
                    format!("Failed to write the concat manifest: {error}"),
                )
            })
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
        fs::write(&list_path, body).map_err(|error| {
            app_error(
                ErrorCode::ExportWriteFailed,
                format!("Failed to write the concat manifest: {error}"),
            )
        })?;
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
        "-map".to_string(),
        "0".to_string(),
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
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis(),
        Err(error) => {
            app_error(
                ErrorCode::SystemClockInvalid,
                format!("System clock is earlier than the Unix epoch: {error}"),
            );
            0
        }
    }
}
