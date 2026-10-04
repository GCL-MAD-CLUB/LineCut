# TransNetV2 assets

Run `npm run prepare:transnetv2` from the repository root to place the runtime
assets required by the storyboard panel in this directory.

Required files:

- `transnetv2.onnx`
- `storyboard-event-model.json`
- `onnxruntime.dll`
- `DirectML.dll`

`storyboard-event-model.json` configures the probability-sequence-only event
decision stage. The checked-in model is explicitly marked
`bootstrap_uncalibrated`; replace its classifier coefficients with a regularized
logistic-regression model trained on labeled candidate events and populate
`calibration` with Beta-calibration parameters fitted on an independent
validation split.

The preparation script also copies package license and notice files beside the
runtime binaries.

## LineCut 0.3.3 runtime integration

The packaged model still has fixed input dimensions `[1, 100, 27, 48, 3]`.
Multiple detections share one inference session and reuse one overwritten input
tensor; they do not increase the model batch dimension. DirectML is preferred
when usable, with CPU inference fallback. Windows FFmpeg extraction separately
requests D3D11VA hardware decoding, which depends on the build, driver and codec.

The session stays warm for 30 seconds after its last task and then retires.
This changes lifecycle and scheduling, not the model license or validation
status. The event coefficients remain `bootstrap_uncalibrated`; do not describe
them as fitted production parameters. See
[the detection pipeline](../../../docs/storyboard-event-detection.md) for bounded
queues, thread budgets, cancellation and diagnostics.
