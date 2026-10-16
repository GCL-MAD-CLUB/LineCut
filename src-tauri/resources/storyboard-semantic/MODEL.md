# DINOv3 storyboard frame selection

Model: [onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX](https://huggingface.co/onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX).
Pinned revision: `81f43e32cbf964b3c284da6cfd3be9fcba6d82ef`.

Run `npm run prepare:storyboard-semantic` to download the FP32 ONNX graph,
external weights, configuration, preprocessing metadata and DINOv3 license,
and apply the DirectML graph compatibility fix described below.
The shared ONNX Runtime and DirectML binaries come from `npm run prepare:transnetv2`.
The build prepares this component automatically; the existing installer semantic
component choice controls both subtitle and storyboard models.

Input: RGB, bilinear resize to 224 × 224 without center cropping, NCHW float32,
rescale 1/255, mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`.
Output: `pooler_output`, 384-dimensional CLS feature, followed by L2 normalization.
Frames are read from the original video stream using the same seek/frame convention
as the native frame trace. Decoding and model batches stay in memory.

CSES relevance is replaced by local visual novelty. For each encoded point, sort
the current encoded set by time and take up to ten neighbors on either side,
excluding the point itself. With rank distance `d`, use
`w_d = sech(d/2) = 1/cosh(d/2)` and compute
`v_i = 1 - sum(w_d * max(0, cos(f_i, f_j))) / sum(w_d)`.
Only existing neighbors contribute to the denominator; a lone point has novelty
zero. Distance is the difference in encoded-point ranks, not source frame numbers.
After active acquisition, recompute every novelty score over the expanded set.
The final log-prominence recalibration still retains the Stage 1 background
median and MAD, as in CSES Equation 9.

The pinned graph's symbolic dimensions `s99`, `s100`, and `s4` are specialized to
the selected batch size, `224`, and `224` when creating each session. The online
batch policy compares 2, 4, 8, 16, and 32 rows using real selection work, starting
at eight when enough frames are available. It excludes session creation, the
first run of each session, padded tails, and decoder wait from throughput samples.
After three full samples per eligible size it chooses the lowest smoothed time
per frame, and continues updating that estimate during normal inference. Small
jobs do not wait for larger calibration batches. No synthetic probes are run.

At most two specialized sessions are resident: the measured winner and a trial
or tail shape. Short tails reuse a resident shape when possible; padding rows
never enter CSES. Decoder transport uses two-frame chunks independently of the
chosen inference batch, retaining all frames in order when the batch changes.
Specialization still lets ONNX Runtime fold the dynamic positional-encoding
shape operations before DirectML execution.
Input specialization alone does not fix ONNX Runtime 1.24 DirectML's
`ReshapeHelper`: with `allowzero=1` it copies `-1` literally instead of inferring
the dimension, causing `node_view_8` to fail its output-shape check. Asset
preparation changes `allowzero` to `0` only on the twelve attention output
reshapes (`node_view_8` through `node_view_52`, step four). Their shared target
shape is `[batch, tokens, -1]`, with positive batch/token counts, so this preserves
the reshape semantics. All weights and other graph fields remain unchanged.
The small graph is checked on every preparation run; existing downloads are
upgraded too, without hashing or downloading the external weights again.
If a larger accelerated batch fails, its size and larger sizes are excluded and
the same real frames are retried in smaller batches. A failure at two rows uses
the shared CPU recovery; after recovery, timing samples and GPU sessions are
discarded and subsequent shapes are created on CPU without probing GPU again.
One-row execution is reserved for a final tail or recovery when larger shapes
cannot run. CSES formulas, frame budgets, scores and stopping rules do not depend
on this policy. As with switching providers, different batch shapes may produce
floating-point rounding differences; mathematical equivalence is not a bitwise
identity guarantee near selection ties.

The manual inline Rust test `dinov3_directml_matches_cpu` runs the packaged graph
with an explicit DirectML session (no automatic CPU recovery) and compares its
eight CLS embeddings against CPU. It is ignored in normal CI.

The weights are unmodified and governed by the [DINOv3 License](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md),
included as `LICENSE.md` beside the downloaded model.
