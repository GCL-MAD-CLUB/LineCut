# Third-party notices

## FFmpeg and FFprobe

The optional bundled `ffmpeg-x86_64-pc-windows-msvc.exe` and
`ffprobe-x86_64-pc-windows-msvc.exe` are FFmpeg 8.0.1 essentials builds. Their
own `-L` output identifies them as GPLv3-or-later builds (`--enable-gpl` and
`--enable-version3`). They are separate executable programs invoked by LineCut.

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

The application code in this repository, excluding those optional FFmpeg and
FFprobe executables, optional TransNetV2/ONNX Runtime assets, and their
respective notices, is licensed under Apache License 2.0; see
[LICENSE](LICENSE).
