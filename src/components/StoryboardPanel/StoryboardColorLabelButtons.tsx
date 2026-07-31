import type { CSSProperties } from "react";
import type {
  StoryboardShotColorLabel,
  StoryboardShotColorLabelFilter,
} from "./storyboardPanelState";

export const storyboardShotColorLabels: Array<readonly [StoryboardShotColorLabel, string]> = [
  ["red", "红色"],
  ["yellow", "黄色"],
  ["green", "绿色"],
  ["blue", "蓝色"],
  ["purple", "紫色"],
];

const storyboardShotColorLabelValues: Record<StoryboardShotColorLabel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};

export const storyboardShotColorFilterLabels: Array<
  readonly [StoryboardShotColorLabelFilter, string]
> = [...storyboardShotColorLabels, ["none", "无"]];

const storyboardShotColorFilterValues: Record<StoryboardShotColorLabelFilter, string> = {
  ...storyboardShotColorLabelValues,
  none: "#7f7f7f",
};

interface StoryboardColorLabelButtonsProps {
  activeValues: readonly StoryboardShotColorLabelFilter[];
  ariaLabel: string;
  buttonLabel: (
    colorLabel: StoryboardShotColorLabelFilter,
    label: string,
    active: boolean,
  ) => string;
  className?: string;
  disabled?: boolean;
  includeNone?: boolean;
  onSelect: (colorLabel: StoryboardShotColorLabelFilter) => void;
}

export function StoryboardColorLabelButtons({
  activeValues,
  ariaLabel,
  buttonLabel,
  className = "",
  disabled = false,
  includeNone = false,
  onSelect,
}: StoryboardColorLabelButtonsProps) {
  const options = includeNone ? storyboardShotColorFilterLabels : storyboardShotColorLabels;

  return (
    <div
      className={["storyboard-color-label-buttons", className].filter(Boolean).join(" ")}
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
                "--storyboard-color-label-color": storyboardShotColorFilterValues[colorLabel],
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
