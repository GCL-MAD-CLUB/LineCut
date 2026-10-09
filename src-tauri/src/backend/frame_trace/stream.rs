use super::{
    metrics::{frame_sharpness, mean_frame_colors},
    ssim::StreamingSsim,
    types::{FrameTraceBatch, FrameTraceData},
    COLOR_FRAME_BYTES, TRACE_HEIGHT, TRACE_WIDTH,
};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub(super) fn send_trace_batch(
    channel: &tauri::ipc::Channel<FrameTraceBatch>,
    values: &FrameTraceData,
    start_frame: i64,
    start: usize,
    end: usize,
) -> std::io::Result<()> {
    channel
        .send(FrameTraceBatch {
            start_frame: start_frame + start as i64,
            previous_motion: start.checked_sub(1).map(|index| values.motion[index]),
            data: FrameTraceData {
                motion: values.motion[start..end.saturating_sub(1)].to_vec(),
                colors: values.colors[start..end].to_vec(),
                sharpness: values.sharpness[start..end].to_vec(),
            },
        })
        .map_err(|error| std::io::Error::other(error.to_string()))
}

pub(super) async fn read_frame_trace(
    reader: &mut (impl AsyncReadExt + Unpin),
    frame_count: i64,
    start_frame: i64,
    channel: Option<&tauri::ipc::Channel<FrameTraceBatch>>,
) -> std::io::Result<FrameTraceData> {
    let mut frame = vec![0; COLOR_FRAME_BYTES];
    let mut gray = Vec::with_capacity(TRACE_WIDTH * TRACE_HEIGHT);
    let mut values = FrameTraceData {
        motion: Vec::with_capacity(frame_count.saturating_sub(1) as usize),
        colors: Vec::with_capacity(frame_count as usize),
        sharpness: Vec::with_capacity(frame_count as usize),
    };
    let mut ssim = StreamingSsim::new();
    let mut sent = 0;
    let mut last_send = std::time::Instant::now();
    for index in 0..frame_count {
        reader.read_exact(&mut frame).await?;
        values.colors.push(mean_frame_colors(&frame));
        values.sharpness.push(frame_sharpness(&frame, &mut gray));
        if let Some(motion) = ssim.sample(&frame) {
            values.motion.push(motion);
        }
        if let Some(channel) = channel {
            // First pair appears immediately. Thereafter amortize IPC over small
            // batches while bounding update latency to about one display frame.
            let end = values.colors.len();
            if end == 2
                || end - sent >= 8
                || last_send.elapsed() >= Duration::from_millis(24)
                || index + 1 == frame_count
            {
                send_trace_batch(channel, &values, start_frame, sent, end)?;
                sent = end;
                last_send = std::time::Instant::now();
            }
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn streamed_batches_keep_every_frame_and_the_boundary_motion() {
        let received = Arc::new(Mutex::new(Vec::<FrameTraceBatch>::new()));
        let sink = received.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        let frames: Vec<u8> = (0..19)
            .flat_map(|frame| vec![frame * 12; COLOR_FRAME_BYTES])
            .collect();
        let complete = futures::executor::block_on(read_frame_trace(
            &mut frames.as_slice(),
            19,
            127,
            Some(&channel),
        ))
        .unwrap();
        let batches = received.lock().unwrap();
        let mut next = 127;
        let mut motions = Vec::new();
        for batch in batches.iter() {
            assert_eq!(batch.start_frame, next);
            assert!(batch.data.is_valid(batch.data.colors.len()));
            if let Some(motion) = batch.previous_motion {
                motions.push(motion);
            }
            motions.extend_from_slice(&batch.data.motion);
            next += batch.data.colors.len() as i64;
        }
        assert_eq!(next, 146);
        assert_eq!(motions.len(), complete.motion.len());
        for (streamed, complete) in motions.iter().zip(&complete.motion) {
            // JSON transport can round the final decimal by one ULP.
            assert!((streamed - complete).abs() < 1e-12);
        }
        assert!(batches.len() >= 3);
    }

    #[test]
    fn color_stream_keeps_each_frame_and_rejects_truncation() {
        futures::executor::block_on(async {
            let mut frames = vec![0; COLOR_FRAME_BYTES];
            frames.extend(vec![255; COLOR_FRAME_BYTES]);
            let values = read_frame_trace(&mut frames.as_slice(), 2, 0, None)
                .await
                .unwrap();
            assert_eq!(values.colors[0], [0.0; 4]);
            assert_eq!(&values.colors[1][..3], &[1.0; 3]);
            assert_eq!(values.sharpness, vec![0.0; 2]);
            assert!(
                read_frame_trace(&mut &frames[..frames.len() - 1], 2, 0, None)
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn sharpness_stream_returns_a_sample_for_single_frame() {
        futures::executor::block_on(async {
            let frame = vec![0; COLOR_FRAME_BYTES];
            let values = read_frame_trace(&mut frame.as_slice(), 1, 0, None)
                .await
                .unwrap();
            assert_eq!(values.sharpness, vec![0.0]);
            assert!(values.is_valid(1));
            assert!(read_frame_trace(&mut &frame[..frame.len() - 1], 1, 0, None)
                .await
                .is_err());
        });
    }
}
