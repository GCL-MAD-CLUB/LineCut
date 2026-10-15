# ONNX 提供器选择与推理回退

生产模型统一通过 `src-tauri/src/backend/onnx.rs` 的 `OnnxModel` 创建和调用。
共享运行库定位和初始化仍使用原有分镜运行库入口，运行库本身缺失、模型文件损坏、
输入非法等问题最终会按既有错误机制报告；CPU 回退不代替这些必要资源。

## 本次失败分析

2026-10-15 的实际日志显示：

- FFmpeg 解码成功，DINOv3 模型通过 DirectML 会话初始化。
- 首次运行在 `node_view_2`（Reshape）报错，异常来自 DirectML 算子计算入口。
- 固定输入尺寸后，错误转移到 `node_view_8`（Reshape），错误码 `0x80070057`。
  日志指向 ONNX Runtime DirectML 的 `InferAndVerifyOutputSizes` 检查：已知输出
  维度与提供器推导的实际输出维度不一致。
- 随后的 CPU 回退能够继续处理后续分镜。原先只在创建会话时回退，无法覆盖首次
  或后续 `Run` 中才出现的提供器错误。

因此，已确认的是当前 DINOv3 导出图在本机 DirectML 路径中的形状推导／执行兼容性问题，
不能仅凭日志进一步归责于显卡硬件、驱动或某一段模型导出代码。固定输入可增加常量折叠
机会，但不是运行成功的保证，也不能代替推理阶段的回退。

对应运行库版本为准备脚本中的 ONNX Runtime 1.24.4。可对照
[DirectML 输出尺寸校验源码](https://github.com/microsoft/onnxruntime/blob/v1.24.4/onnxruntime/core/providers/dml/DmlExecutionProvider/src/MLOperatorAuthorImpl.cpp#L2853)
及 [DirectML 配置与输入尺寸说明](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html#performance-tuning)。

## 覆盖范围

| 生产入口            | 模型加载回退                    | 推理失败回退                              | 后续调用                             |
| ------------------- | ------------------------------- | ----------------------------------------- | ------------------------------------ |
| 分镜切分 TransNetV2 | DirectML 各适配器失败后尝试 CPU | 相同 100 帧窗口在 CPU 重试                | 复用 CPU，保持原窗口、输出顺序和进度 |
| 字幕索引及查询 Jina | 同上                            | 相同 token、mask、批大小和长度在 CPU 重试 | 复用 CPU；索引原有缩批机制继续保留   |
| 分镜选帧 DINOv3     | 同上，并保留固定输入维度        | 相同补齐后的图像批次在 CPU 重试           | 复用 CPU，只返回真实帧的向量         |

会话创建成功与推理成功是两个独立阶段。推理回退只尝试一次，不在 GPU 与 CPU 间循环。
如果 CPU 初始化或重试也失败，错误保留 GPU 与 CPU 两段原因；不会把失败结果当成功结果。
所有输出在公共调用成功后才提交，避免重复发布批次、重复累计分镜预测或提前写入索引。

公共会话通过互斥锁串行调用，满足 DirectML 的会话线程要求。CPU 重建保留模型路径、
固定维度及原有 CPU 线程预算。取消在推理前、失败后、CPU 重建后和重试后检查；取消后
不启动新的回退，也不发布已取消调用的结果。任务报告的提供器随运行期回退更新为 CPU。

显式 CPU／DirectML 性能探针位于测试代码中，仍保持指定提供器，避免回退掩盖测量对象。
它们不属于生产调用路径，也没有在本次工作中运行。

## 验证

使用不依赖模型、GPU 或媒体的回退状态测试，覆盖 GPU 成功、相同输入重试、CPU 复用、
双重失败、CPU 重建失败及取消边界；同时运行已有的分镜调度单元测试。
不执行真实视频、模型冒烟或浏览器测试。
