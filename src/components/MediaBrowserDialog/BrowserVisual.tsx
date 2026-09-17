import { useEffect, useRef, useState } from "react";
import { File, Folder } from "lucide-react";
import { invokeCommand, runOperation } from "../../errors";
import { createFfmpegTaskId } from "../../ffmpegProgress";

let active = 0;
const waiting: Array<() => void> = [];
async function queued<T>(action: () => Promise<T>) {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await action();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}
const icons = new Map<string, Promise<string>>();
function iconSource(path: string) {
  let result = icons.get(path);
  if (!result) {
    result = queued(async () => {
      const outcome = await runOperation("thumbnail.video", () =>
        invokeCommand<{ width: number; height: number; pixels: number[] } | null>(
          "media_browser_icon",
          { path },
        ),
      );
      if (outcome.status !== "success" || !outcome.value) return "";
      const { width, height, pixels } = outcome.value;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas
        .getContext("2d")
        ?.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      return canvas.toDataURL();
    });
    if (icons.size > 512) icons.clear();
    icons.set(path, result);
  }
  return result;
}
export function BrowserSystemIcon({
  path,
  directory = false,
}: {
  path: string;
  directory?: boolean;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    void iconSource(path).then((value) => {
      if (live) setSrc(value);
    });
    return () => {
      live = false;
    };
  }, [path]);
  return src ? (
    <img className="media-browser-system-icon" src={src} alt="" draggable={false} />
  ) : directory ? (
    <Folder aria-hidden="true" />
  ) : (
    <File aria-hidden="true" />
  );
}

export function BrowserVisual({
  path,
  directory,
  preview,
}: {
  path: string;
  directory: boolean;
  preview: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [cover, setCover] = useState("");
  const [frame, setFrame] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const hoverTimeRef = useRef<number | null>(null);
  hoverTimeRef.current =
    progress === null
      ? null
      : Math.min(Math.round(duration * progress), Math.max(0, duration - 40_000));
  useEffect(() => {
    if (progress === null || !duration || !preview || !visible) {
      setFrame("");
      return;
    }
    let live = true;
    let url = "";
    let timer = 0;
    let previousTime = -1;
    async function update() {
      const timeUs = hoverTimeRef.current;
      if (!live || timeUs === null) return;
      if (Math.abs(timeUs - previousTime) >= 40_000 || previousTime < 0) {
        previousTime = timeUs;
        await queued(async () => {
          if (!live) return;
          const outcome = await runOperation("thumbnail.video", () =>
            invokeCommand<number[]>("media_browser_frame", { path, timeUs }),
          );
          if (live && outcome.status === "success") {
            const next = URL.createObjectURL(
              new Blob([new Uint8Array(outcome.value)], { type: "image/jpeg" }),
            );
            const old = url;
            url = next;
            setFrame(next);
            URL.revokeObjectURL(old);
          }
        });
      }
      if (live) timer = window.setTimeout(() => void update(), 70);
    }
    void update();
    return () => {
      live = false;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
  }, [progress !== null, duration, path, preview, visible]);
  const isVideo =
    preview && !directory && /\.(mp4|mov|mkv|avi|webm|m4v|mts|m2ts|ts|mpeg|mpg)$/i.test(path);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !isVideo) return;
    let live = true;
    let url = "";
    void queued(async () => {
      if (!live) return;
      const outcome = await runOperation("thumbnail.video", () =>
        invokeCommand<number[]>("media_browser_frame", { path, timeUs: 0 }),
      );
      if (live && outcome.status === "success") {
        url = URL.createObjectURL(
          new Blob([new Uint8Array(outcome.value)], { type: "image/jpeg" }),
        );
        setCover(url);
      }
    });
    return () => {
      live = false;
      URL.revokeObjectURL(url);
      setCover("");
    };
  }, [visible, isVideo, path]);
  useEffect(() => {
    if (progress === null || duration > 0 || !isVideo) return;
    let live = true;
    void queued(async () => {
      if (!live) return;
      const result = await runOperation("thumbnail.video", () =>
        invokeCommand<Array<{ duration_us: number }>>("probe_media_link_files", {
          paths: [path],
          taskId: createFfmpegTaskId("browser-preview"),
        }),
      );
      if (live && result.status === "success") setDuration(result.value[0]?.duration_us ?? 0);
    });
    return () => {
      live = false;
    };
  }, [progress !== null, duration, isVideo, path]);
  return (
    <span
      ref={host}
      className="media-browser-file-visual is-icon"
      onPointerMove={(event) => {
        if (!isVideo || event.buttons) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setProgress(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
      }}
      onPointerLeave={() => setProgress(null)}
    >
      {cover ? (
        <img
          className="media-browser-frame"
          src={progress === null ? cover : frame || cover}
          alt=""
          draggable={false}
        />
      ) : (
        visible && <BrowserSystemIcon path={path} directory={directory} />
      )}
    </span>
  );
}
