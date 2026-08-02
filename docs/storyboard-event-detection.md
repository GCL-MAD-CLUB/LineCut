# Storyboard scene-cut inference

The storyboard detector implements the TransNetV2 Temporal Residual Refiner
(TTRR) pipeline. The former candidate-event classifier, non-maximum suppression,
and minimum-shot-length penalty are not part of the runtime.

For every display-order video frame, Rust produces eight raw features in this
fixed order:

1. TransNetV2 single-frame probability.
2. TransNetV2 all-frames probability.
3. Luma mean absolute difference.
4. 32-bin luma histogram Hellinger distance.
5. Dilated Sobel edge-change ratio.
6. The 90th percentile of 4×4 tile luma differences.
7. Flash-return evidence.
8. A valid-frame mask.

Both TransNetV2 heads are mandatory. TransNetV2 runs in 100-frame windows and
contributes the middle 50 results. The refiner also consumes 100 frames in
channel-major `[1, 8, 100]` layout, emits the middle 50 frames, and advances by
50 frames. Missing head or tail context uses probability `0.5`, zero low-level
features, and a zero valid mask.

`src-tauri/resources/transnetv2/scene_cut_refiner.manifest.json` defines the
dual-head calibrator, base threshold, normalization metadata, model contract,
TransNetV2 SHA-256, and conservative/balanced/sensitive thresholds. The runtime
rejects a manifest or ONNX model that does not match this contract.

`scene_cut_refiner.onnx` is optional. When it is present, the three outputs must
be `final_logits`, `base_logits`, and `delta_logits`, each with shape `[1, 50]`,
and Rust verifies `final_logits = base_logits + delta_logits`. When it is absent,
the detector remains operational in base-only mode:

```text
delta_logits = 0
final_logits = calibrated_base_margin
```

Rust applies the selected manifest threshold directly to each final logit. It
does not apply NMS, merge adjacent boundaries, enforce a minimum shot length, or
limit cuts per second. Frame zero is always forced to `false`.

Frame timestamps come from ffprobe display-frame PTS and must align one-to-one
with decoded frames. A boundary at frame `t` means frame `t` is the first frame
of the new shot; therefore the preceding shot ends at frame `t - 1`. This keeps
variable-frame-rate media aligned without deriving timestamps from
`frame_index / fps`.

The checked-in manifest is a runnable, explicitly `bootstrap_uncalibrated`
base-only configuration. Model-quality evaluation requires replacing its
calibrator, normalization values, and thresholds with artifacts fitted on
whole-video train/validation splits.
