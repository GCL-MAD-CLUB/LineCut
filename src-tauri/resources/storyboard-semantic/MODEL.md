# Storyboard selection and semantic retrieval

## SigLIP2 semantic retrieval

Selected frames are encoded with `vision_model_fp16.onnx` from
`onnx-community/siglip2-base-patch16-256-ONNX`, pinned revision
`d1114256522a37ffa257a0a58017348ab0058db2`. Queries use the paired
`text_model_int8.onnx` and `tokenizer.json`. Assets live in the `siglip2/`
subdirectory, are verified against pinned SHA-256 digests, and are prepared by
the same `npm run prepare:storyboard-semantic` command and installed by the
existing semantic component choice.

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

Vision execution follows the selection encoder's online batch policy, reusable
tensors, smaller-batch retry and shared ONNX CPU recovery. Each encoder retains
the five 2/4/8/16/32-row specialized sessions and, if necessary, a one-row recovery
session. Challengers and tail shapes survive stage changes and subsequent builds;
only provider recovery or failed shapes discard sessions. Short tails reuse
resident shapes, and pending text queries get priority before the next vision batch.

Cold selection decodes each original shot once to 256 x 256 RGB. Adjacent uncached
shots of one media source share a continuous FFmpeg process. Two-frame transport
chunks have a 32-frame queue, allowing decoding to continue during inference.
Probe inference reads that stream while retaining the whole current shot in
memory; acquisition reuses it. DINOv3 receives a center-aligned bilinear 256-to-224
resize of those pixels, and SigLIP2 directly reuses selected 256-pixel frames.
The full-shot buffer is released after selection; only selected pixels cross a
bounded media handoff. SigLIP2 for one media can overlap selection and decoding
for the next media. Complete caches require neither decoding nor inference;
when only a semantic index needs repair, only missing selected frames are decoded,
coalescing nearby frames and seeking over gaps greater than two seconds.
Windows requests D3D11VA decoding with up to 16 processing threads and checks
`scale_d3d11` compilation once per FFmpeg program. When present, it requests
`-hwaccel_output_format d3d11` and tries GPU resize to 256 before NV12 download
and RGB conversion. Real work validates device/media compatibility. Before any
pixels have been emitted, failures fall back through explicit NV12 download with
software resize, the original automatic download path, and software decoding.
Sparse `select` always precedes explicit download and resize. A bounded cache
remembers failed paths per program/media/stream; later shots skip them. Closed
consumers and partially emitted streams never retry or replay into inference.
Closing a consumer terminates and joins
its decoder. No inferred selection is committed until its merged decoder exits
successfully; the semantic index likewise requires validated pixels.
The query encoder runs on CPU in its own serialized session because DirectML can
produce inconsistent embeddings for this quantized graph without an inference
error. The ignored inline test `siglip2_query_encoder_provider_diagnostics`
validates normalized outputs and reports the DirectML/CPU cosine for manual
diagnosis; it does not require a particular provider defect.

Selection and vision encoding occupy one cancellable task. A storyboard counts
as complete only after both stages succeed. The same progress bar adds the independent
selection and SigLIP2 counters with 75% and 25% weights respectively, including overlapping media. Both stages report batch
progress and cached shot completion; the last fraction of each shot is reserved
for successful validation and persistence. Semantic indexes live in the configured
cache root as
`Storyboard Semantic Search/<fingerprint>/<recipe-media hash>/<sequence>-<UUID>.bin`.
The revision hash includes the complete model/recipe, media length and timestamp;
stream and frame rate remain part of each shot key. Modification time retains the
original nanosecond precision in directories, keys and records so existing cache
identities remain unchanged. Current length and whole-second time must match the imported asset;
a changed source requires reimport instead of building another generation under a
stale fingerprint. Cache timestamps are not truncated to whole seconds.
Cache revisions remain unchanged: Keyframe uses `dinov3-cses-v1` and the semantic
recipe retains its `rgb256-l2-v1` suffix. Keyframe uses the same layout
under `Storyboard Keyframe`. Existing storage formats are neither read nor migrated.

Both caches share `storage.rs`. Shards rotate by size at 256 MiB, aggregating many
shots; their sequence is parsed from filenames without opening file headers.
Each record stores one shot snapshot, bounded to 4 MiB (Keyframe limits its codec
to 2 MiB). Headers carry length, shot key, payload SHA-256 and a SHA-256 covering
all preceding header fields. Header verification precedes trusting keys/lengths;
payload verification precedes deserialization. Readers scan headers under a
per-media process lock, pin handles, then read and decode only requested shots
outside the lock. The cache directory must not be written by multiple processes.

Committed records remain reusable after cancellation. Torn suffixes are truncated
before append. Resynchronizing after a damaged middle advances the committed
high-water mark through later healthy records, so append cannot truncate them.
A shot becomes searchable only after its decoder succeeds and every vector exists.
Invalid vectors in a verified, decodable record are re-encoded individually.
The 32 MiB decoded-record LRU retains unrelated shots across appends; external
file changes invalidate their tokens. Media and model files are not rehashed.

After each append batch, obsolete bytes trigger compaction at
`max(64 KiB, live record bytes / 2)`. Compaction streams the latest verified record
for each key into size-limited temporary shards, syncs every file, publishes higher
sequences, syncs the directory, and only then removes old shards. Any latest-record
read or checksum failure aborts compaction and retains every old shard. Maintenance
failures are logged only in the backend; they never produce frontend warnings or
fail an already successful append.
Copying is
cancellable; publication is not. Interrupted publication leaves safe duplicates.
The first committed batch for a new recipe/media generation also removes obsolete
generation directories for that fingerprint. Successful cleanup is remembered for
that generation in the current process, avoiding repeated parent-directory scans.
Cleanup is lazy on writes, not a
background sweep of unused media.

Semantic checkpoints append all their shot records with one lock, one directory
barrier and one maintenance pass. Each touched shard calls `sync_all` once, at
rotation or batch completion. Records retain individual commit markers: cancellation
syncs the committed prefix and drops only an uncommitted record. Keyframe single
records use the same batch implementation. Unix additionally syncs directory
creation, compaction publication and removal; generation cleanup syncs its parent
only when a directory was removed. Windows standard-library APIs provide no directory fsync
barrier: file contents are synced and process crashes are recoverable, but namespace
changes are not guaranteed durable across sudden power loss. Invalid/missing cache
records are rebuilt from source media.

Source: [SigLIP2 ONNX](https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX),
[upstream model](https://huggingface.co/google/siglip2-base-patch16-256), Apache-2.0.

## DINOv3 frame selection

Model: [onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX](https://huggingface.co/onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX).
Pinned revision: `81f43e32cbf964b3c284da6cfd3be9fcba6d82ef`.

Run `npm run prepare:storyboard-semantic` to download the FP32 ONNX graph,
external weights, configuration, preprocessing metadata and DINOv3 license,
and apply the DirectML graph compatibility fix described below.
Every asset is verified against its pinned upstream SHA-256 digest, both after
downloading and when it already exists locally; a mismatch is re-downloaded.
`model.onnx` accepts either the upstream digest or the digest of the prepared
graph, so the check runs before and after the in-place DirectML patch. Change the
pinned revisions and their digests together.
The shared ONNX Runtime and DirectML binaries come from `npm run prepare:transnetv2`.
The build prepares this component automatically; the existing installer semantic
component choice controls both subtitle and storyboard models.

Input: original stream resized once to RGB 256 × 256 (D3D11 video processing when
available, bilinear software fallback), followed by a
center-aligned bilinear resize to 224 × 224 without center cropping, NCHW float32,
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
Every successful real batch, including the first run and padded tails, advances
calibration once. After three real runs per eligible size it chooses the lowest
smoothed measured time per frame, and continues updating that estimate during
normal inference. Untimed shapes never displace a measured winner. Small
jobs do not wait for larger calibration batches. No synthetic probes are run.

At most six specialized sessions per encoder are resident, covering all tuned
shapes and the one-row recovery shape. Short tails reuse a resident shape when possible; padding rows
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
upgraded too, without downloading the external weights again.
If a larger accelerated batch fails, its size and larger sizes are excluded and
the same real frames are retried in smaller batches. A failure at two rows uses
the shared CPU recovery; after recovery, timing samples and GPU sessions are
discarded and subsequent shapes are created on CPU without probing GPU again.
One-row execution is reserved for a final tail or recovery when larger shapes
cannot run. CSES formulas, frame budgets, scores and stopping rules do not depend
on this policy. As with switching providers, different batch shapes may produce
floating-point rounding differences. Shared 256-to-224 preprocessing also differs
from decoding directly to 224, so selections from the two preprocessing paths are not guaranteed
identical near selection ties. CSES formulas, ordering and tie rules are unchanged.

The manual inline Rust test `dinov3_directml_matches_cpu` runs the packaged graph
with an explicit DirectML session (no automatic CPU recovery) and compares its
eight CLS embeddings against CPU. It is ignored in normal CI.

The weights are unmodified and governed by the [DINOv3 License](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md),
included as `LICENSE.md` beside the downloaded model.
