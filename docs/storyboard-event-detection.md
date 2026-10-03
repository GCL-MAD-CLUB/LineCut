# Storyboard event detection

The storyboard detector uses only the frame-level probability sequence produced
by TransNetV2. It does not use histograms, optical flow, color differences, or
other image statistics.

The decision pipeline is:

1. Clamp probabilities and transform them to logits.
2. Estimate a local logit background with the median and MAD.
3. Generate high-recall local-maximum candidates.
4. Expand candidates into intervals and merge overlapping event intervals.
5. Extract event-level peak, prominence, area, width, concentration, slope,
   asymmetry, local-background, and neighboring-mass features.
6. Estimate event probability with the configured logistic-regression model.
7. Optionally apply Beta calibration.
8. Derive the decision threshold from false-positive and false-negative costs.
9. Apply deterministic non-maximum suppression.
10. Apply the minimum-shot-length sigmoid penalty and make the final decision.

The runtime model is
`src-tauri/resources/transnetv2/storyboard-event-model.json`. Its
`feature_order` is validated to prevent coefficients from being applied to the
wrong inputs. A missing model file falls back to the same
`bootstrap_uncalibrated` defaults, while a malformed model file stops detection
with an explicit error.

## Extraction and inference

The frontend task scheduler starts up to three storyboard detections at once,
matching the task bar's three progress slots. When any running detection settles,
the next waiting detection immediately fills the free slot. Other task operations
retain exclusive execution and FIFO ordering. Cancelling all tasks temporarily
pauses refilling so waiting work cannot start during cancellation.

Each detection task has a dedicated blocking FFmpeg reader. It sends blocks of
50 RGB frames through its own bounded queue, with at most four blocks waiting.
A full queue blocks that producer, while other tasks continue independently.
FFmpeg decoder, filter, and rawvideo encoder thread counts use the existing
CPU-aware worker budget divided across two concurrent extractions rather than
three: the extraction slots are rarely all decoding at the same instant, and
decoding paces the pipeline, so a larger share per extraction keeps it off the
critical path. The same per-stage ceiling applies as for other media workers.

One process-wide inference thread owns the ONNX Runtime Session. It probes
DirectML adapters and loads the model once for overlapping tasks, then visits
their queues in round-robin order. Predictions, progress, frame windows, and
padding belong to each task. Window assembly retains the original 100-frame
inputs, 50-frame stride, 25 copies of the first frame on the left, and last-frame
padding on the right. FFmpeg extraction settings apart from thread budgets,
Session options, and cut decisions are unchanged.

Cancelling a task closes and discards only its queue and stops its FFmpeg
process. Extraction or inference errors fail only that task. The consumer uses
notifications with timed waits so cancellation works even without arriving
frames. Admission and retirement share a lock: once all admitted tasks and
their queues have finished, the consumer drops its Session and exits; a later
task starts a new consumer.
A consumer panic is explicitly logged at error level with its panic payload.

This overlaps decoding and inference, changing their contribution to total
runtime from their sum toward the slower stage, plus startup and final draining.
It does not reduce decoding cost. Software decoding of 1080p input can remain
the bottleneck, so GPU utilization need not rise substantially. Lower-resolution
proxies or hardware decoding would require a separate change.

## Training and validation

The checked-in coefficients are startup parameters, not fitted or calibrated
production parameters. A production model must be trained on labeled candidate
events using regularized, class-weighted binary cross-entropy. Do not train on
all frames.

Split train, validation, and test data by complete video. Fit the logistic model
on the training videos, fit Beta calibration on validation videos that preserve
the real event prevalence, and use the test videos only for final reporting.
Candidate generation parameters must be frozen before measuring the test set.

Report event-level precision, recall, F1, and PR-AUC, plus false positives and
false negatives per video hour. Report exact-frame matching and tolerances of
plus or minus one and two frames. The candidate threshold is tuned for recall;
precision is controlled by the event model and the cost-derived decision
threshold.
