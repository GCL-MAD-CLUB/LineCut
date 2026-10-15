# DINOv3 storyboard frame selection

Model: [onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX](https://huggingface.co/onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX).
Pinned revision: `81f43e32cbf964b3c284da6cfd3be9fcba6d82ef`.

Run `npm run prepare:storyboard-semantic` to download the original FP32 ONNX
graph, external weights, configuration, preprocessing metadata and DINOv3 license.
The shared ONNX Runtime and DirectML binaries come from `npm run prepare:transnetv2`.
The build prepares this component automatically; the existing installer semantic
component choice controls both subtitle and storyboard models.

Input: RGB, bilinear resize to 224 × 224 without center cropping, NCHW float32,
rescale 1/255, mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`.
Output: `pooler_output`, 384-dimensional CLS feature, followed by L2 normalization.
Frames are read from the original video stream using the same seek/frame convention
as the native frame trace. Decoding and model batches stay in memory.

The pinned graph's symbolic dimensions `s99`, `s100`, and `s4` are fixed to
`8`, `224`, and `224` when creating the session. Short batches are padded to eight
rows and only real-frame embeddings are returned. This lets ONNX Runtime fold
the dynamic positional-encoding shape operations before DirectML execution.
If DirectML still fails during inference, the same batch is retried on CPU;
subsequent batches reuse that CPU session for the rest of the process.

The weights are unmodified and governed by the [DINOv3 License](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md),
included as `LICENSE.md` beside the downloaded model.
