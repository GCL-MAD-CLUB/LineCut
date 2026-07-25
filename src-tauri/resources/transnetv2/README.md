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
