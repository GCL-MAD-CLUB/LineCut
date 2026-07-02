export function formatDuration(us: number) {
  const totalMs = Math.max(0, Math.round(us / 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")}`;
}

function nominalFrameRate(frameRate: number) {
  return Math.max(1, Math.round(frameRate));
}

export function formatMonitorTime(us: number, frameRate = 24) {
  const fps = nominalFrameRate(frameRate);
  const totalFrames = Math.max(0, Math.round((us / 1_000_000) * fps));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const frameDigits = Math.max(2, String(fps - 1).length);
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}:${frames
    .toString()
    .padStart(frameDigits, "0")}`;
}

export function parseMonitorTime(value: string, frameRate = 24) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, hh, mm, ss, ff] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const frames = Number(ff);
  const fps = nominalFrameRate(frameRate);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    !Number.isInteger(frames) ||
    minutes > 59 ||
    seconds > 59 ||
    frames >= fps
  ) {
    return null;
  }
  const totalFrames = ((hours * 60 + minutes) * 60 + seconds) * fps + frames;
  return Math.round((totalFrames / fps) * 1_000_000);
}
