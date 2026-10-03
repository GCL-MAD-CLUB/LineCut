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
On Windows, FFmpeg requests hardware decoding with input-scoped
`-hwaccel d3d11va`. Hardware output format is left unset so decoded frames can
feed the software scale/RGB filter in system memory. With a budget of `C` physical
CPU cores, the backend admits at most `W = min(C, 3)` extractions and assigns
each `T = min(floor(C / W), 16)` FFmpeg threads. Thus the sum of input `-threads`
values across active extractions cannot exceed `C`. For example, a CPU with
16 physical cores and 22 logical processors allows three extractions with five
threads each, totaling 15. Windows processor topology supplies the physical core
count; available process parallelism can lower that limit. The topology query
counts the calling processor group, conservatively underusing multi-group CPUs.
If physical topology cannot be determined, the budget falls back to one thread.
Filter and rawvideo output options use the same per-extraction thread setting.
This bounds configured FFmpeg parallelism, not the total OS thread count across
FFmpeg, ONNX Runtime, drivers and I/O readers.

A process-wide semaphore enforces admission even for direct backend requests.
One- and two-core systems admit only one and two extractions respectively.
Waiting requests remain cancellable. An extraction holds its slot until its
FFmpeg process has been stopped and reaped, including failure and cancellation.

One process-wide inference thread owns the ONNX Runtime Session. It probes
DirectML adapters and loads the model once for overlapping tasks, then visits
their queues in round-robin order. Predictions, progress, frame windows, and
padding belong to each task. Window assembly retains the original 100-frame
inputs, 50-frame stride, 25 copies of the first frame on the left, and last-frame
padding on the right. One reusable float32 input tensor serves all tasks; it is
fully overwritten before each synchronous inference, so no task can inherit
another task's frame data. Only the first prediction output is requested, and
the center probabilities are read directly from that output. The packaged
model has fixed input dimensions `[1, 100, 27, 48, 3]`; increasing the batch size
requires a separately validated model. Extraction keeps every decoded frame
and outputs 48×27 RGB data with the existing bilinear scaling. Cut decision
rules are unchanged.

DirectML retains sequential execution and disabled memory patterns. CPU
fallback uses half the available logical CPU count (rounded down), bounded
to 1–8 intra-op threads, instead of forcing every operator onto one thread.

Cancelling a task closes and discards only its queue and stops its FFmpeg
process. Extraction or inference errors fail only that task. The consumer uses
notifications with timed waits so cancellation works even without arriving
frames. A successful session stays warm for 30 seconds after its last task,
covering frontend queue refills and nearby detection requests. An idle session
waits for a notification instead of polling. After the idle timeout, admission
and retirement share a lock: the consumer checks for new tasks again, drops
its Session and exits. Failed initialization retires immediately so later
requests can retry. Warm sessions retain their model memory during the timeout.
A consumer panic is explicitly logged at error level with its panic payload.

This overlaps decoding and inference, changing their contribution to total
runtime from their sum toward the slower stage, plus startup and final draining.
Hardware decoding can reduce CPU decode work; the existing software scaling,
GPU-to-system-memory transfers and inference still contribute to runtime.
The requested accelerator depends on the FFmpeg build, GPU/driver and input
codec. FFmpeg extraction failures continue to fail the task with its diagnostics.

## Decision-stage performance

The local probability/logit medians use a sorted sliding window. The monotonic
logit transform preserves ordering, so both medians use the same middle
elements, while retaining the original even-window arithmetic at clip edges.
MAD uses one reusable scratch buffer instead of allocating for every frame.
Non-maximum suppression retains the same greedy priority and strict distance
comparison, but checks an ordered frame index instead of scanning all retained
events. Its worst-case comparison cost drops from quadratic to `O(E log E)` for
`E` candidates. Decision work runs on a blocking worker rather than occupying
the asynchronous command executor.

Tests compare sliding statistics bit for bit against independently sorted
windows, indexed suppression against the original greedy scan, and reused
ONNX inputs against fresh tensors with all outputs requested. They cover clip
edges, non-finite probabilities, duplicate peaks, zero/maximum distances,
interleaved task windows, cancellation, warm reuse and session retirement.

An optimized Rust microbenchmark on 180,000 in-memory probabilities, using the
median of five runs and identical cut outputs, measured:

| Probability sequence           | Previous decision stage | Optimized decision stage |
| ------------------------------ | ----------------------: | -----------------------: |
| Isolated peak every 100 frames |               116.63 ms |                 42.62 ms |
| Isolated peak every 5 frames   |              1006.26 ms |                 69.43 ms |
| Deterministic uniform samples  |               247.02 ms |                 85.31 ms |

These are local decision-stage measurements, not end-to-end video speedups.
No videos were generated for these checks. Runtime tracing records model
initialization, frame-stream read time, producer queue wait time, accumulated
input packing and inference time, and per-task pipeline/decision/total time.
Frame-stream read time includes waiting for FFmpeg; queue wait time reflects
backpressure. Overlapping stage times must not be added as wall-clock duration.
Packing/inference totals are logged when the warm session retires.

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
