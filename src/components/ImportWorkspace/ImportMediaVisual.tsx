import { Captions, FileAudio2, FileVideo2, Image } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ImportFolderIcon } from "./ImportFolderIcon";
import { mediaKind, type ImportEntry, type ImportMetadata } from "./importBrowserModel";
import { importCover, importFrame, importMetadata, queuePreview } from "./importPreview";

export function ImportMediaVisual({
  entry,
  scrub = false,
  onMetadata,
}: {
  entry: ImportEntry;
  scrub?: boolean;
  onMetadata?: (metadata: ImportMetadata) => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [cover, setCover] = useState("");
  const [frame, setFrame] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const position = useRef(progress);
  position.current = progress;
  const reportMetadata = useRef(onMetadata);
  reportMetadata.current = onMetadata;
  const kind = entry.is_directory ? null : mediaKind(entry.path);
  const Icon =
    kind === "audio"
      ? FileAudio2
      : kind === "image"
        ? Image
        : kind === "subtitle"
          ? Captions
          : FileVideo2;
  useEffect(() => {
    const observer = new IntersectionObserver(([item]) => setVisible(item.isIntersecting), {
      rootMargin: "100px",
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !kind || kind === "subtitle") return;
    let live = true;
    if (kind === "video" || kind === "image")
      void importCover(entry.path).then((src) => {
        if (live) setCover(src);
      });
    if (onMetadata || scrub)
      void importMetadata(entry.path).then((metadata) => {
        if (!live || !metadata) return;
        setDuration(metadata.duration_us);
        reportMetadata.current?.(metadata);
      });
    return () => {
      live = false;
    };
  }, [entry.path, visible, kind, scrub, Boolean(onMetadata)]);
  const hovering = progress !== null;
  useEffect(() => {
    if (!hovering || !duration || !scrub || kind !== "video") return;
    let live = true;
    let timer = 0;
    let previous = -1;
    async function update() {
      if (!live || position.current === null) return;
      const time = Math.min(
        Math.floor((duration * position.current) / 100_000) * 100_000,
        Math.max(0, duration - 100_000),
      );
      if (time !== previous) {
        previous = time;
        const src = await queuePreview(() =>
          live ? importFrame(entry.path, time) : Promise.resolve(""),
        );
        if (live && src) setFrame(src);
      }
      if (live) timer = window.setTimeout(() => void update(), 90);
    }
    timer = window.setTimeout(() => void update(), 100);
    return () => {
      live = false;
      window.clearTimeout(timer);
      setFrame("");
    };
  }, [hovering, duration, scrub, kind, entry.path]);
  return (
    <span
      ref={host}
      className="import-media-visual"
      onPointerMove={(event) => {
        if (!scrub || kind !== "video" || event.buttons) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setProgress(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
      }}
      onPointerLeave={() => setProgress(null)}
    >
      {cover ? (
        <img src={hovering && frame ? frame : cover} alt="" draggable={false} />
      ) : entry.is_directory ? (
        <ImportFolderIcon />
      ) : (
        <Icon strokeWidth={1.2} />
      )}
      {scrub && hovering && cover && (
        <span className="import-scrub-line" style={{ left: `${progress! * 100}%` }} />
      )}
    </span>
  );
}
