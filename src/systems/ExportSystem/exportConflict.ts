import { invokeCommand } from "../../errors";
import { clampFileName } from "./exportRename";
import type { ExportClip, ExportMode } from "./exportTypes";

/** User choice for every conflicting target file, applied to all of them at once. */
export type ExportConflictAction = "overwrite" | "skip" | "uniqueName" | "cancel";

/** One output target that already exists on disk (or could be written to). */
export interface ExportConflict {
  /** The clip whose output this target is; null for the single merged file. */
  clipId: string | null;
  path: string;
  fileName: string;
  /** Clip label for the dialog list; unused for merge targets. */
  clipLabel: string;
}

export function joinPath(dir: string, name: string): string {
  if (!dir) {
    return name;
  }
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/** Mirrors the backend `safe_component` (storage.rs): leading dots/spaces are stripped and the name is clamped to 120 chars, so conflict probes match the path ffmpeg will actually write. */
function effectiveOutputName(fileName: string): string {
  const trimmed = fileName.replace(/^[.\s]+/, "").trim();
  return clampFileName(trimmed);
}

/**
 * Computes the output targets for an export. In merge mode only the first clip's
 * file matters: the backend names the single merged file after the explicit
 * `options.output_name` the frontend sends (which is the first clip's rename
 * result), falling back to `probed[0]`; in individual mode every clip has its
 * own target.
 */
export function buildExportTargets(
  clips: readonly ExportClip[],
  outputDir: string,
  names: Map<string, string>,
  mode: ExportMode,
): ExportConflict[] {
  if (mode === "merge") {
    const fileName = names.get(clips[0]?.id ?? "");
    if (!fileName) {
      return [];
    }
    const effective = effectiveOutputName(fileName);
    return [
      {
        clipId: null,
        path: joinPath(outputDir, effective),
        fileName: effective,
        clipLabel: "",
      },
    ];
  }
  return clips
    .map((clip): ExportConflict | null => {
      const fileName = names.get(clip.id);
      if (!fileName) {
        return null;
      }
      const effective = effectiveOutputName(fileName);
      return {
        clipId: clip.id,
        path: joinPath(outputDir, effective),
        fileName: effective,
        clipLabel: clip.label,
      };
    })
    .filter((target): target is ExportConflict => target !== null);
}

/**
 * Keeps only the targets whose file already exists on disk. A failed existence
 * check is treated as "does not exist" so non-Tauri previews behave as before.
 */
export async function findExistingTargets(
  targets: readonly ExportConflict[],
): Promise<ExportConflict[]> {
  const existing = await Promise.all(
    targets.map(async (target) => {
      try {
        return {
          target,
          exists: await invokeCommand<boolean>("path_is_file", { path: target.path }),
        };
      } catch {
        return { target, exists: false };
      }
    }),
  );
  return existing.filter((entry) => entry.exists).map((entry) => entry.target);
}

/**
 * Returns the first non-existing `-N` sibling of `currentName` on disk, or
 * `null` when no candidate is free within `maxTries`. A thrown existence check
 * is treated as "not there" so a broken IPC call never blocks the export.
 */
async function nextFreeFileName(
  dir: string,
  stem: string,
  ext: string,
  reservedNames: ReadonlySet<string>,
  startNumber: number,
): Promise<string | null> {
  const maxTries = 1000;
  for (let index = 0; index < maxTries; index += 1) {
    const candidate = effectiveOutputName(`${stem}-${startNumber + index}${ext}`);
    if (reservedNames.has(candidate)) {
      continue;
    }
    try {
      const exists = await invokeCommand<boolean>("path_is_file", {
        path: joinPath(dir, candidate),
      });
      if (!exists) {
        return candidate;
      }
    } catch {
      // A failed check means "not there" from the exporter's point of view.
      return candidate;
    }
  }
  // No free name in range; returning null lets the caller cancel instead of
  // silently overwriting an existing file.
  return null;
}

/**
 * Picks a new `-N` name for `currentName` that neither exists on disk nor
 * collides with `reservedNames` (the rest of the batch's final names). The
 * suffix starts at `startNumber`, matching `assignUniqueNames` (exportRename.ts).
 */
export async function resolveUniqueFileName(
  dir: string,
  currentName: string,
  reservedNames: ReadonlySet<string>,
  startNumber: number,
): Promise<string | null> {
  const dot = currentName.lastIndexOf(".");
  const start = Math.max(0, Math.floor(startNumber));
  if (dot <= 0) {
    // No extension (or a leading dot): reuse the same suffix pattern directly.
    return nextFreeFileName(dir, currentName, "", reservedNames, start);
  }
  const stem = currentName.slice(0, dot);
  const ext = currentName.slice(dot);
  return nextFreeFileName(dir, stem, ext, reservedNames, start);
}

/** Drops clips whose output target conflicts (used by the "skip" action). */
export function filterConflictingClips(
  clips: readonly ExportClip[],
  conflicts: readonly ExportConflict[],
): ExportClip[] {
  const conflictedIds = new Set(
    conflicts.flatMap((conflict) => (conflict.clipId === null ? [] : [conflict.clipId])),
  );
  return clips.filter((clip) => !conflictedIds.has(clip.id));
}
