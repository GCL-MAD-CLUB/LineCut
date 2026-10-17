# Storyboard selection and semantic retrieval

## SigLIP2 semantic retrieval

Selected frames are encoded with `vision_model_fp16.onnx` from
`onnx-community/siglip2-base-patch16-256-ONNX`, pinned revision
`d1114256522a37ffa257a0a58017348ab0058db2`. Queries use the paired
`text_model_int8.onnx` and `tokenizer.json`. Assets live in the `siglip2/`
subdirectory and are prepared by the same `npm run prepare:storyboard-semantic`
command and installed by the existing semantic component choice.

Vision input is RGB, bilinear resize to 256 × 256, NCHW float32,
rescale 1/255 and mean/std 0.5. FP16 describes the model weights; the exported
graph's input/output tensors are float32. Text uses the tokenizer's EOS template,
right padding with token 0 to 64 tokens, and truncation to 64 tokens. Queries
are passed directly without Jina prefixes or classification prompt templates.
Both graphs return a 768-dimensional `pooler_output`, normalized to unit length.
The score of a storyboard is the calibrated match probability of its best
selected frame: take the maximum cosine similarity across the shot's frame
embeddings, then apply the checkpoint's trained pair logits,
`sigmoid(exp(logit_scale) * cosine + logit_bias)` with `logit_scale = 4.726513`
and `logit_bias = -16.771803`. Those two parameters belong to the upstream
`google/siglip2-base-patch16-256` checkpoint and are not part of the exported
sub-graphs. The transform is monotone, so the best frame is unchanged. It yields
the model's 0..1 pairwise match score using the same transformation as
[`SiglipModel`](https://github.com/huggingface/transformers/blob/main/src/transformers/models/siglip/modeling_siglip.py)
and the zero-shot pipeline. Scores are not
min-max normalized across results, and the reported value is never rescaled by
the number of selected frames.

Vision execution follows the selection encoder's online batch policy, bounded
two-chunk RGB decoder queue, reusable tensors, at most two specialized sessions,
smaller-batch retry and shared ONNX CPU recovery. Only completed inference batches
are checkpointed. Pending text queries get priority before the next vision batch.
The query encoder runs on CPU in its own serialized session because DirectML can
produce inconsistent embeddings for this quantized graph without an inference
error. The ignored inline test `siglip2_query_encoder_provider_diagnostics`
validates normalized outputs and reports the DirectML/CPU cosine for manual
diagnosis; it does not require a particular provider defect.

Selection and vision encoding occupy one cancellable task. A storyboard counts
as complete only after both stages succeed. The same progress bar assigns 50% to
selection across the scope and 50% to SigLIP2 indexing. Both stages report batch
progress and cached shot completion; the last fraction of each shot is reserved
for successful validation and persistence. Semantic indexes live in the configured
cache root as `Storyboard Semantic Search/<recipe hash>/<media key>.bin`,
independently of `Storyboard Keyframe`. That is the subtitle layout: one revision
directory holding one index per source file, so every storyboard of one media
shares a single index instead of writing a file per shot at the cache root.
The media key hashes only the recipe, media fingerprint and stream; media length,
timestamps and frame rate are stored inside the file, so a re-encoded source
replaces its own index instead of leaving an orphan behind. Each shot stores its
range, selected positions and one vector per position. Complete shots are reused
across panels and projects; building another scope preserves existing shots, and
its checkpoints do not hide completed shots from retrieval. A changed selection
or media re-encodes only what it invalidates. Each validated inference batch is
checkpointed, so partial shots resume their missing frames. Invalid vectors are
re-encoded individually while healthy vectors remain reusable; invalid shot
structure or an unreadable file is rebuilt.
Indexes written by the earlier per-shot layout, including partial checkpoints,
are adopted into the media index and then removed after successful persistence.
Cached index reads
use a bounded 32 MiB memory layer and file stamps; media and model files are not
rehashed.

Source: [SigLIP2 ONNX](https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX),
[upstream model](https://huggingface.co/google/siglip2-base-patch16-256), Apache-2.0.

## DINOv3 frame selection

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
