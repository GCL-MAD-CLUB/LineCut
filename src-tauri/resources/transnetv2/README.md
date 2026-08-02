# TransNetV2 assets

Run `npm run prepare:transnetv2` from the repository root to place the runtime
assets required by the storyboard panel in this directory.

Required files:

- `transnetv2.onnx`
- `scene_cut_refiner.manifest.json`
- `onnxruntime.dll`
- `DirectML.dll`

Optional file:

- `scene_cut_refiner.onnx`

The manifest contains the dual-head TransNetV2 calibrator, its base threshold,
the low-level feature normalization metadata, and the three final decision
thresholds. If `scene_cut_refiner.onnx` is absent, inference remains available in
base-only mode: `delta_logits` is exactly zero and `final_logits` equals the
calibrated base margin.

The checked-in manifest is explicitly marked `bootstrap_uncalibrated`; replace
its calibrator, normalization statistics, and decision thresholds with values
trained on whole-video splits before evaluating model quality. A deployed TTRR
ONNX file must match the static `[1, 8, 100]` input and three `[1, 50]` outputs
declared by the manifest.

The preparation script also copies package license and notice files beside the
runtime binaries.
