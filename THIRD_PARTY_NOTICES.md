# Third-party notices

## Locution Pro UI Sans

The bundled `src/assets/fonts/locution-pro-ui-sans-vf.woff2` is the Simplified Chinese
face extracted from Adobe Source Han Sans's `SourceHanSans-VF.ttf.ttc`, converted
to WOFF2 without character subsetting. It retains the variable weight range
250–900 and is renamed Locution Pro UI Sans to respect the reserved font name.

Source Han Sans is copyright 2014–2025 Adobe and is licensed under the SIL Open
Font License 1.1. The full license is included in `src/assets/fonts/OFL.txt` and
installed as `licenses/locution-pro-ui-sans-OFL.txt`.

- <https://github.com/adobe-fonts/source-han-sans>

## FFmpeg and FFprobe

The optional bundled `ffmpeg-x86_64-pc-windows-msvc.exe` and
`ffprobe-x86_64-pc-windows-msvc.exe` are FFmpeg 8.0.1 essentials builds. Their
own `-L` output identifies them as GPLv3-or-later builds (`--enable-gpl` and
`--enable-version3`). They are separate executable programs invoked by Locution Pro.

FFmpeg is copyright The FFmpeg developers and is licensed under the GNU General
Public License, version 3 or (at your option) any later version. Its license and
corresponding source are available from the FFmpeg project:

- <https://ffmpeg.org/legal.html>
- <https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz>
- <https://github.com/FFmpeg/FFmpeg/tree/n8.0.1>

## TransNetV2 storyboard detection assets

The optional bundled `transnetv2/transnetv2.onnx` model is an ONNX conversion
of TransNetV2. The model card identifies it as MIT licensed and points to the
original TransNetV2 repository:

- <https://huggingface.co/elya5/transnetv2>
- <https://github.com/soCzech/TransNetV2>

The optional bundled `transnetv2/onnxruntime.dll` comes from the
`Microsoft.ML.OnnxRuntime.DirectML` NuGet package. The optional bundled
`transnetv2/DirectML.dll` comes from its `Microsoft.AI.DirectML` dependency.
The asset preparation script copies the package license and third-party notice
files beside those binaries when preparing the bundle resources.

- <https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime.DirectML>
- <https://www.nuget.org/packages/Microsoft.AI.DirectML>

## Jina subtitle semantic search assets

The bundled `semantic-search/model_quantized.onnx`, its external weight file,
and tokenizer come from `jinaai/jina-embeddings-v5-text-nano-retrieval`, revision
`ac5d898c8d382b17167c33e5c8af644a3519b47d`. These Jina AI model assets are licensed
under **CC BY-NC 4.0**, including the noncommercial restriction. The original
license is included at `semantic-search/LICENSE.txt`. Commercial use requires a
separate license from Jina AI. The model is used without weight modifications.

- <https://huggingface.co/jinaai/jina-embeddings-v5-text-nano-retrieval>
- <https://creativecommons.org/licenses/by-nc/4.0/>

Semantic search shares the bundled ONNX Runtime and DirectML binaries described
above. `npm run prepare:semantic` downloads the pinned INT8 model and tokenizer.

## DINOv3 storyboard frame selection assets

The paired SigLIP2 models used after frame selection are
`vision_model_fp16.onnx` and `text_model_int8.onnx` from
`onnx-community/siglip2-base-patch16-256-ONNX`, revision
`d1114256522a37ffa257a0a58017348ab0058db2`, based on Google's
`siglip2-base-patch16-256` (Apache-2.0). The model weights are unmodified.
Their tokenizer and preprocessing metadata are distributed in
`storyboard-semantic/siglip2/`; they share the ONNX runtime described above.

- <https://huggingface.co/google/siglip2-base-patch16-256>
- <https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX>

The optional `storyboard-semantic/model.onnx` and its external weights come from
`onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX`, pinned to revision
`81f43e32cbf964b3c284da6cfd3be9fcba6d82ef`. The unmodified DINOv3 weights are governed
by the DINOv3 License, included at `storyboard-semantic/LICENSE.md`. This component
shares the ONNX Runtime and DirectML binaries described above.

- <https://huggingface.co/onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX>
- <https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md>

The application code in this repository, excluding the bundled UI font, optional FFmpeg and
FFprobe executables, optional TransNetV2/ONNX Runtime assets, Jina and DINOv3 model assets, and their
respective notices, is licensed under Apache License 2.0; see
[LICENSE](LICENSE).
