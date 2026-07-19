use super::*;

pub(crate) async fn parse_embedded_subtitle_async(
    video_path: &Path,
    stream_index: i32,
    codec: &str,
    track_id: &str,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    let output_codec = if matches!(codec.to_ascii_lowercase().as_str(), "ass" | "ssa") {
        "ass"
    } else {
        "srt"
    };
    let args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_path.to_string_lossy().into_owned(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-f".to_string(),
        output_codec.to_string(),
        "pipe:1".to_string(),
    ];
    let program = ffmpeg_program(preferences);
    let text = run_output(&program, &args, state, task_id, cancel.clone()).await?;
    let track_id = track_id.to_string();
    let output_codec = output_codec.to_string();
    spawn_blocking_cancellable(cancel, "parse embedded subtitles", move |cancel| {
        parse_subtitle_text_cancellable(&text, &output_codec, &track_id, Some(cancel))
    })
    .await
}

pub(crate) fn load_external_subtitle_cancellable(
    path: &str,
    asset_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<(SubtitleTrack, Vec<SubtitleCue>, Option<UserNotice>)> {
    check_optional_cancel(cancel)?;
    let subtitle_path = PathBuf::from(path);
    let track_id = Uuid::new_v4().to_string();
    let mut track = SubtitleTrack {
        id: track_id.clone(),
        asset_id: asset_id.to_string(),
        source_type: SubtitleSourceType::External,
        stream_index: None,
        source_path: Some(path.to_string()),
        codec: "unknown".to_string(),
        language: None,
        title: subtitle_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned()),
        kind: SubtitleKind::Text,
        offset_us: 0,
        cue_count: 0,
        warning: None,
    };

    if !subtitle_path.exists() {
        let display_name = subtitle_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("字幕文件");
        let message = format!("外挂字幕不存在：{display_name}");
        track.warning = Some(message.clone());
        return Ok((
            track,
            Vec::new(),
            Some(UserNotice::warning_with_detail(
                "EXTERNAL_SUBTITLE_MISSING",
                message,
                format!("missing subtitle path: {path}"),
            )),
        ));
    }

    let codec = codec_from_path(&subtitle_path);
    track.codec = codec.clone();
    track.title = subtitle_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned());

    match parse_subtitle_file_cancellable(&subtitle_path, &codec, &track_id, cancel) {
        Ok(cues) => {
            track.cue_count = cues.len();
            Ok((track, cues, None))
        }
        Err(error) if error.is(ErrorCode::TaskCancelled) => Err(error),
        Err(error) => {
            let display_name = subtitle_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("字幕文件");
            let message = format!("外挂字幕解析失败：{display_name}");
            track.warning = Some(message.clone());
            Ok((
                track,
                Vec::new(),
                Some(UserNotice::warning_with_detail(
                    "EXTERNAL_SUBTITLE_PARSE_FAILED",
                    message,
                    format!("subtitle path: {path}; detail: {}", error.detail()),
                )),
            ))
        }
    }
}

pub(crate) async fn load_external_subtitle_async(
    path: String,
    asset_id: String,
    cancel: Arc<AtomicBool>,
) -> AppResult<(SubtitleTrack, Vec<SubtitleCue>, Option<UserNotice>)> {
    spawn_blocking_cancellable(cancel, "parse external subtitles", move |cancel| {
        load_external_subtitle_cancellable(&path, &asset_id, Some(cancel))
    })
    .await
}

pub(crate) fn parse_subtitle_file_cancellable(
    path: &Path,
    codec: &str,
    track_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    check_optional_cancel(cancel)?;
    let bytes = fs::read(path).map_err(|error| {
        app_error(
            ErrorCode::SubtitleReadFailed,
            format!("Failed to read subtitle file {}: {error}", path.display()),
        )
    })?;
    check_optional_cancel(cancel)?;
    let text = decode_text(&bytes);
    parse_subtitle_text_cancellable(&text, codec, track_id, cancel)
}

pub(crate) fn parse_subtitle_text_cancellable(
    text: &str,
    codec: &str,
    track_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    check_optional_cancel(cancel)?;
    let lower_codec = codec.to_ascii_lowercase();

    if lower_codec.contains("ass") || lower_codec.contains("ssa") {
        let cues = parse_ass_cancellable(text, track_id, cancel)?;
        normalize_cues_cancellable(cues, track_id, cancel)
    } else {
        let cues = parse_srt_or_vtt_cancellable(text, track_id, cancel)?;
        normalize_cues_cancellable(cues, track_id, cancel)
    }
}

pub(crate) fn normalize_cues_cancellable(
    mut cues: Vec<SubtitleCue>,
    track_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    check_optional_cancel(cancel)?;
    cues.sort_by_key(|cue| (cue.start_us, cue.end_us, cue.sequence));

    let mut merged: Vec<SubtitleCue> = Vec::new();
    for (index, cue) in cues.into_iter().enumerate() {
        if index % 256 == 0 {
            check_optional_cancel(cancel)?;
        }
        if let Some(last) = merged.last_mut() {
            if last.start_us == cue.start_us && last.end_us == cue.end_us {
                append_unique_line(&mut last.raw_text, &cue.raw_text);
                append_unique_line(&mut last.plain_text, &cue.plain_text);
                merge_optional_field(&mut last.speaker, cue.speaker);
                merge_optional_field(&mut last.style, cue.style);
                if last.layer.is_none() {
                    last.layer = cue.layer;
                }
                continue;
            }
        }
        merged.push(cue);
    }

    for (index, cue) in merged.iter_mut().enumerate() {
        if index % 256 == 0 {
            check_optional_cancel(cancel)?;
        }
        cue.sequence = index as i32;
        cue.id = format!("{track_id}:{index}");
        cue.track_id = track_id.to_string();
    }

    check_optional_cancel(cancel)?;
    Ok(merged)
}

pub(crate) fn append_unique_line(target: &mut String, next: &str) {
    let trimmed = next.trim();
    if trimmed.is_empty() || target.lines().any(|line| line.trim() == trimmed) {
        return;
    }
    if !target.trim().is_empty() {
        target.push('\n');
    }
    target.push_str(trimmed);
}

pub(crate) fn merge_optional_field(target: &mut Option<String>, next: Option<String>) {
    let Some(next_value) = next.map(|value| value.trim().to_string()) else {
        return;
    };
    if next_value.is_empty() {
        return;
    }

    match target {
        Some(current) if current.split(" / ").any(|value| value == next_value) => {}
        Some(current) if !current.is_empty() => {
            current.push_str(" / ");
            current.push_str(&next_value);
        }
        _ => *target = Some(next_value),
    }
}

pub(crate) fn parse_srt_or_vtt_cancellable(
    text: &str,
    track_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    let normalized = normalize_newlines(text);
    let lines = normalized.lines().collect::<Vec<_>>();
    let timing_re = Regex::new(
        r"(?P<start>(?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,6})\s*-->\s*(?P<end>(?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,6})",
    )
    .expect("valid timing regex");
    let mut cues = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        if i % 256 == 0 {
            check_optional_cancel(cancel)?;
        }
        let mut line = lines[i].trim();
        if line.is_empty() || line.eq_ignore_ascii_case("WEBVTT") {
            i += 1;
            continue;
        }
        if line.starts_with("NOTE") || line.starts_with("STYLE") || line.starts_with("REGION") {
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        if !line.contains("-->") {
            if i + 1 < lines.len() && lines[i + 1].contains("-->") {
                i += 1;
                line = lines[i].trim();
            } else {
                i += 1;
                continue;
            }
        }

        let Some(captures) = timing_re.captures(line) else {
            i += 1;
            continue;
        };
        let start_us = parse_subtitle_time(&captures["start"]);
        let end_us = parse_subtitle_time(&captures["end"]);
        i += 1;

        let mut text_lines = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            text_lines.push(lines[i]);
            i += 1;
        }

        let raw_text = text_lines.join("\n");
        let plain_text = clean_plain_text(&raw_text);
        if end_us > start_us && !plain_text.is_empty() {
            let sequence = cues.len() as i32;
            cues.push(SubtitleCue {
                id: format!("{track_id}:{sequence}"),
                track_id: track_id.to_string(),
                sequence,
                start_us,
                end_us,
                raw_text,
                plain_text,
                speaker: None,
                style: None,
                layer: None,
            });
        }
    }

    check_optional_cancel(cancel)?;
    Ok(cues)
}

pub(crate) fn parse_ass_cancellable(
    text: &str,
    track_id: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<Vec<SubtitleCue>> {
    let normalized = normalize_newlines(text);
    let mut in_events = false;
    let mut fields = vec![
        "layer".to_string(),
        "start".to_string(),
        "end".to_string(),
        "style".to_string(),
        "name".to_string(),
        "marginl".to_string(),
        "marginr".to_string(),
        "marginv".to_string(),
        "effect".to_string(),
        "text".to_string(),
    ];
    let mut cues = Vec::new();

    for (line_index, line) in normalized.lines().enumerate() {
        if line_index % 256 == 0 {
            check_optional_cancel(cancel)?;
        }
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_events = trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(format_line) = trimmed.strip_prefix("Format:") {
            fields = format_line
                .split(',')
                .map(|value| value.trim().to_ascii_lowercase())
                .collect();
            continue;
        }
        let Some(dialogue) = trimmed.strip_prefix("Dialogue:") else {
            continue;
        };
        let parts = dialogue
            .trim()
            .splitn(fields.len(), ',')
            .map(str::trim)
            .collect::<Vec<_>>();
        if parts.len() < fields.len() {
            continue;
        }

        let start = ass_value(&fields, &parts, "start").unwrap_or_default();
        let end = ass_value(&fields, &parts, "end").unwrap_or_default();
        let raw_text = ass_value(&fields, &parts, "text")
            .unwrap_or_default()
            .to_string();
        let start_us = parse_ass_time(start);
        let end_us = parse_ass_time(end);
        let plain_text = clean_plain_text(&raw_text);

        if end_us <= start_us || plain_text.is_empty() {
            continue;
        }

        let sequence = cues.len() as i32;
        cues.push(SubtitleCue {
            id: format!("{track_id}:{sequence}"),
            track_id: track_id.to_string(),
            sequence,
            start_us,
            end_us,
            raw_text,
            plain_text,
            speaker: optional_string(ass_value(&fields, &parts, "name")),
            style: optional_string(ass_value(&fields, &parts, "style")),
            layer: ass_value(&fields, &parts, "layer").and_then(|value| value.parse().ok()),
        });
    }

    check_optional_cancel(cancel)?;
    Ok(cues)
}

pub(crate) fn ass_value<'a>(fields: &[String], parts: &[&'a str], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .position(|field| field == name)
        .and_then(|index| parts.get(index).copied())
}

pub(crate) fn optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn clean_plain_text(raw: &str) -> String {
    let mut text = raw
        .replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ")
        .replace("&nbsp;", " ");
    let ass_tag_re = Regex::new(r"\{[^}]*\}").expect("valid ass tag regex");
    text = ass_tag_re.replace_all(&text, "").into_owned();
    let html_tag_re = Regex::new(r"<[^>]+>").expect("valid html tag regex");
    text = html_tag_re.replace_all(&text, "").into_owned();
    let whitespace_re = Regex::new(r"[ \t\r\n]+").expect("valid whitespace regex");
    whitespace_re.replace_all(text.trim(), " ").into_owned()
}

pub(crate) fn parse_subtitle_time(value: &str) -> i64 {
    let normalized = value.trim().replace(',', ".");
    let parts = normalized.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0, parse_i64(minutes), *seconds),
        [hours, minutes, seconds] => (parse_i64(hours), parse_i64(minutes), *seconds),
        _ => return 0,
    };
    let (seconds_whole, fraction_us) = parse_seconds_fraction(seconds, 3);
    ((hours * 3600 + minutes * 60 + seconds_whole) * 1_000_000) + fraction_us
}

pub(crate) fn parse_ass_time(value: &str) -> i64 {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    let [hours, minutes, seconds] = parts.as_slice() else {
        return 0;
    };
    let (seconds_whole, fraction_us) = parse_seconds_fraction(seconds, 2);
    ((parse_i64(hours) * 3600 + parse_i64(minutes) * 60 + seconds_whole) * 1_000_000) + fraction_us
}

pub(crate) fn parse_seconds_fraction(value: &str, default_fraction_digits: usize) -> (i64, i64) {
    let mut split = value.split('.');
    let seconds_whole = parse_i64(split.next().unwrap_or_default());
    let fraction = split.next().unwrap_or_default();
    let mut digits = fraction.chars().take(6).collect::<String>();
    if digits.is_empty() && default_fraction_digits == 2 {
        digits.push_str("00");
    }
    while digits.len() < 6 {
        digits.push('0');
    }
    (seconds_whole, parse_i64(&digits))
}

pub(crate) fn parse_decimal_seconds_to_us(value: &str) -> i64 {
    let trimmed = value.trim();
    let negative = trimmed.starts_with('-');
    let number = trimmed.trim_start_matches('-');
    let mut split = number.split('.');
    let seconds = parse_i64(split.next().unwrap_or_default());
    let mut fraction = split
        .next()
        .unwrap_or_default()
        .chars()
        .take(6)
        .collect::<String>();
    while fraction.len() < 6 {
        fraction.push('0');
    }
    let result = seconds * 1_000_000 + parse_i64(&fraction);
    if negative {
        -result
    } else {
        result
    }
}

pub(crate) fn parse_i64(value: &str) -> i64 {
    value.trim().parse::<i64>().unwrap_or(0)
}

pub(crate) fn normalize_newlines(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

pub(crate) fn decode_text(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    for encoding in [GBK, BIG5, SHIFT_JIS, WINDOWS_1252] {
        let (decoded, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return decoded.into_owned();
        }
    }

    let (decoded, _, _) = GBK.decode(bytes);
    decoded.into_owned()
}

pub(crate) fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
    )
}

pub(crate) fn codec_from_path(path: &Path) -> String {
    match path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "ass" => "ass".to_string(),
        "ssa" => "ssa".to_string(),
        "vtt" | "webvtt" => "webvtt".to_string(),
        _ => "subrip".to_string(),
    }
}
