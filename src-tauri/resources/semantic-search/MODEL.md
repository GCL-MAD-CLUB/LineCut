# Subtitle semantic search model

Run `npm run prepare:semantic` at the repository root to populate this directory.
Builds prepare these assets before compiling the native application.

- Model: `jinaai/jina-embeddings-v5-text-nano-retrieval`
- Revision: `ac5d898c8d382b17167c33e5c8af644a3519b47d`
- ONNX weights: `model_quantized.onnx` and `model_quantized.onnx_data` (INT8)
- Tokenizer: `tokenizer.json`
- Runtime: shared ONNX Runtime / DirectML libraries in `../transnetv2`
- License: CC BY-NC 4.0, downloaded as `LICENSE.txt`; see `THIRD_PARTY_NOTICES.md`

Generated files are ignored by Git. The preparation script verifies the model
and tokenizer against their upstream SHA-256 digests.
