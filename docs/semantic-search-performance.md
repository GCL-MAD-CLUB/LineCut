# Subtitle semantic indexing performance

Measured on 2026-10-10 on an Intel Core Ultra 9 185H (22 logical CPUs) and Intel Arc integrated graphics, using the packaged Jina INT8 model and Rust ONNX Runtime. These are synthetic subtitle samples, not a timing of a complete user project. Hardware load, drivers, subtitle lengths, and CPU/GPU selection affect results.

The manual probe runs with the development Rust profile. Inference runs in the packaged native ONNX Runtime DLL; tokenizer and cache measurements also include unoptimized Rust code. No videos or application index files are used. All generated indexes and ORT traces are temporary and removed after the probe.

## Baseline measurements (2026-10-10)

| Measurement                                       | Result             |
| ------------------------------------------------- | ------------------ |
| DirectML adapter 0, 10-token subtitle, warm mean  | 31.17 ms per cue   |
| DirectML adapter 0, 24-token subtitle, warm mean  | 156.35 ms per cue  |
| DirectML adapter 0, 46-token subtitle, warm mean  | 184.17 ms per cue  |
| DirectML adapter 0, alternating the three lengths | 129.41 ms per cue  |
| CPU, current 8-thread budget, alternating lengths | 396.11 ms per cue  |
| CPU, 1 thread, alternating lengths                | 1303.30 ms per cue |
| DirectML session creation                         | 386.26 ms          |
| Tokenizer loading for that session                | 1834.41 ms         |
| Per-cue tokenization                              | 0.10-0.65 ms       |
| Hashing 1000 cues                                 | 2.65 ms            |
| Writing a 1000-cue file index                     | 78.35 ms           |
| Reading and validating that file index            | 79.25 ms           |

A separate ORT trace of one 24-token cue recorded 194 GPU node events totaling 154.385 ms and 10 CPU node events totaling 0.731 ms. CPU nodes were Concat, Gather, GatherBlockQuantized, and Unsqueeze. Node timing totals are diagnostic measurements and are not end-to-end wall times; they show that CPU fallback is not the dominant cost in this sample.

## Causes

Before optimization, the file-index builder called `EmbeddingModel::embed` sequentially for every nonempty cue. Each invocation performed one `Session::run` with shape `[1, token_count]`, then reads `last_hidden_state` and extracts a single normalized embedding. A 1000-cue file therefore needed 1000 separate model runs. At the measured alternating-length DirectML rate, inference alone would take about 129 seconds; this is an extrapolation, not a complete-project measurement.

The scalar path changed the input shape whenever the token count changed. First evaluations measured roughly 201-227 ms on DirectML, versus warm repeats of 31-184 ms. Shape-specific initialization can add cost. The [official DirectML performance documentation](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html#performance-tuning) explains that dimensions known at session creation allow more optimization and initialization in advance. The present probe does not isolate or quantify compilation cost separately from GPU execution.

The shared TransNetV2 session setup chooses the first usable DirectML adapter and falls back to CPU only after initialization failures. It does not compare throughput for this text model. On this machine DirectML is faster than either tested CPU setting, so switching to CPU would worsen indexing here.

Initial model and tokenizer loading add around 2.2 seconds once per application process. Hashing, cache validation, and writing are comparatively small. Completed A indexes are reused when adding B to a scope. Previously, indexes were persisted only after an entire file completed, so cancelling a partly completed file required recomputing that unfinished file on retry.

Tasks can additionally wait behind other operations in the application task queue, and all semantic model operations used one session mutex for the entire file. Those are possible waiting costs, distinct from per-cue inference time; they were not included in this probe. Every completed cue previously published task progress through IPC, but the probe did not measure the frontend cost of those updates.

## Implemented optimizations (2026-10-11)

- Indexing encodes text once, sorts documents by token length, and processes batches of up to 16 documents. Padding uses 16/32/64/128/256/512-token buckets with a 1024-token batch budget. Longer inputs have a smaller batch, and the 8192-token limit is preserved. A singleton uses its actual length to avoid unnecessary padding.
- Right padding uses the tokenizer's pad token and zero attention masks. Each row pools its last real token and normalizes to 768 dimensions. Batch failures retry smaller batches, ultimately preserving scalar inference when necessary.
- Completed file cache format and content hashes are unchanged, so existing file indexes remain usable. A bounded 32 MiB memory cache shares validated vectors across repeated searches and checks file metadata before reuse.
- File-version snapshots map subtitle-text hashes to the previous file index. Editing a cue can reuse unchanged embeddings, including cues beyond the cross-file reuse limit. Identical text is inferred once within a file and reused across available files.
- Checksummed `.partial` journals append completed batches instead of rewriting the whole partial index. Cancellation/retry reuses completed vectors, incomplete records are discarded, and incomplete indexes are never used for retrieval. The complete file is still written atomically. Native cache writers serialize and recheck files, preventing overlapping requests from rebuilding the same completed file or corrupting a checkpoint.
- Tokenization and cache checks run outside the model lock. Indexing releases that lock after each batch and gives waiting queries priority, allowing a different panel's already-indexed search to run during a background build.
- Progress IPC is throttled to at most about 10 updates per second, with immediate initialization, total changes, and completion. TaskSystem still updates the progress bar; these updates no longer notify subtitle search hooks or repeatedly serialize request keys.
- Diagnostic logs report files, missing-file cue count, computed unique documents, and total indexing time without recording subtitle contents.

## Optimized full-path comparison

Measured with the same packaged model, Rust ONNX Runtime, and hardware as the baseline, using unique Chinese, Japanese, and English synthetic subtitles of different lengths. Timings compare scalar document inference against the optimized builder, including batching, checkpoint writes, complete-file writes, and file snapshot writes. Model loading is excluded from both timings. These are sample measurements, not a universal speed guarantee or a timing of a user project.

| Provider           | Unique cues | Original scalar path | Optimized file build | Speedup | Warm cached build |
| ------------------ | ----------- | -------------------- | -------------------- | ------- | ----------------- |
| DirectML adapter 0 | 96          | 16.33 s              | 4.35 s               | 3.76x   | 0.90 ms           |
| CPU, 8 threads     | 24          | 10.22 s              | 1.41 s               | 7.27x   | 0.39 ms           |

The minimum cosine similarity against the original individual embeddings was 0.999999 for both providers. The real-model test additionally verifies A+B reuse, one-cue edit reuse, and the tokenizer's 8192-token truncation limit. Unit tests cover row order after grouping, repeated text, cancelled builds, torn/corrupt checkpoint recovery, cached file validation, bounded batching, smaller-batch retries, and query priority. Browser tests cover the existing cancellation/scope transitions and verify that progress does not rerender a memoized subtitle search consumer.

Separate batch-size measurements on short English samples showed approximately 43 ms per cue at 16 rows and 39-40 ms per cue at 32 rows on DirectML. The default remains 16 to keep memory and cancellation latency lower. Fixed-dimension session pools are not enabled: they would multiply model memory and are unnecessary for the measured gain from batching.

## Reproduce

Prepare the packaged resources, then run the ignored diagnostic test alone:

```powershell
npm run prepare:transnetv2
npm run prepare:semantic
cargo test --manifest-path src-tauri/Cargo.toml packaged_int8_indexing_profile -- --ignored --nocapture --test-threads=1
```

Compare the original path against the optimized production builder with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml packaged_int8_optimized_indexing_smoke -- --ignored --nocapture --test-threads=1
```

The original profiling command is a manual performance diagnostic and has no timing pass/fail threshold. It retains production model loading, tokenizer, embedding, and cache functions. A separate DirectML adapter-0 trace reports operator placement without adding profiling overhead to the timing runs. It requires a working DirectML adapter for that trace.
