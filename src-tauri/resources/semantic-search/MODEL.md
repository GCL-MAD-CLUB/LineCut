# Subtitle semantic search assets

Maintainer resource reference for Locution Pro 0.4.0. Subtitle retrieval is an
optional text workflow; video import, shot detection and visual search do not
require subtitles.

Run `npm run prepare:semantic` from the repository root. The preparation command
downloads pinned assets and checks model and tokenizer digests.

| Resource  | Contract                                                 |
| --------- | -------------------------------------------------------- |
| Model     | jinaai/jina-embeddings-v5-text-nano-retrieval            |
| Revision  | ac5d898c8d382b17167c33e5c8af644a3519b47d                 |
| Weights   | model_quantized.onnx and model_quantized.onnx_data, INT8 |
| Tokenizer | tokenizer.json                                           |
| Runtime   | Shared ONNX Runtime and DirectML assets in ../transnetv2 |
| License   | CC BY-NC 4.0, supplied as LICENSE.txt                    |

The upstream README and license are downloaded resources, not application help.
Do not rewrite their provenance or license terms to match the application version.

`backend/semantic_search.rs` uses the shared `OnnxModel` runtime and source
classified errors. Search consumes the processed subtitle read view, preserving
source cues and files. Cache reuse depends on text, model and embedding recipe;
changes to these inputs must invalidate incompatible vectors.

See [media contracts](../../../docs/media-processing.md) and
[third-party notices](../../../THIRD_PARTY_NOTICES.md) for maintenance and licensing.
