import type { CSSProperties } from "react";
import type { SubtitleCueColorLabel, SubtitleCueColorLabelFilter } from "./subtitlePanelState";

export const subtitleCueColorLabels: Array<readonly [SubtitleCueColorLabel, string]> = [
  ["red", "红色"],
  ["yellow", "黄色"],
  ["green", "绿色"],
  ["blue", "蓝色"],
  ["purple", "紫色"],
];

export const subtitleCueColorLabelValues: Record<SubtitleCueColorLabel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};

export const subtitleCueColorFilterLabels: Array<readonly [SubtitleCueColorLabelFilter, string]> = [
  ...subtitleCueColorLabels,
  ["custom", "自定义"],
  ["none", "无"],
];

const subtitleCueColorFilterValues: Record<SubtitleCueColorLabelFilter, string> = {
  ...subtitleCueColorLabelValues,
  custom: "#ffffff",
  none: "#7f7f7f",
};

interface SubtitleColorLabelButtonsProps {
  activeValues: readonly SubtitleCueColorLabelFilter[];
  ariaLabel: string;
  buttonLabel: (colorLabel: SubtitleCueColorLabelFilter, label: string, active: boolean) => string;
  className?: string;
  disabled?: boolean;
  includeNone?: boolean;
  onSelect: (colorLabel: SubtitleCueColorLabelFilter) => void;
}

export function SubtitleColorLabelButtons({
  activeValues,
  ariaLabel,
  buttonLabel,
  className = "",
  disabled = false,
  includeNone = false,
  onSelect,
}: SubtitleColorLabelButtonsProps) {
  const options = includeNone ? subtitleCueColorFilterLabels : subtitleCueColorLabels;

  return (
    <div
      className={["subtitle-color-label-buttons", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      {options.map(([colorLabel, label]) => {
        const active = activeValues.includes(colorLabel);
        const controlLabel = buttonLabel(colorLabel, label, active);
        return (
          <button
            key={colorLabel}
            type="button"
            className={active ? "active" : ""}
            style={
              {
                "--subtitle-color-label-color": subtitleCueColorFilterValues[colorLabel],
              } as CSSProperties
            }
            onClick={() => onSelect(colorLabel)}
            disabled={disabled}
            title={controlLabel}
            aria-label={controlLabel}
            aria-pressed={active}
          />
        );
      })}
    </div>
  );
}
