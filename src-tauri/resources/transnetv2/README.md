# Shot detection assets

Maintainer resource reference for Locution Pro 0.4.0. Shot detection operates on
video pictures and does not require subtitle tracks.

## Preparation

Run `npm run prepare:transnetv2` from the repository root. Required resources are:

- transnetv2.onnx
- storyboard-event-model.json
- onnxruntime.dll
- DirectML.dll

Preparation also copies the corresponding license and notice files. Keep resource
provenance separate from product help; see
[third-party notices](../../../THIRD_PARTY_NOTICES.md).

## Detection contracts

The model input remains fixed at `[1, 100, 27, 48, 3]`. Concurrent detections
share a serialized inference session and reusable input tensor, rather than
changing model batch dimensions. The session stays warm for 30 seconds after
its last task.

DirectML is preferred when usable, with shared CPU inference recovery.
Windows FFmpeg extraction separately requests D3D11VA decoding; driver, build
and codec compatibility must be verified independently of inference availability.

The event decision configuration consumes only the probability sequence.
Checked-in coefficients remain marked `bootstrap_uncalibrated`; do not describe
them as trained or calibrated production parameters. A fitted replacement needs
labeled event training and independent calibration data.

Bounded queues, cancellation, stale result rejection and storage requirements
are maintained in [media processing](../../../docs/media-processing.md).
