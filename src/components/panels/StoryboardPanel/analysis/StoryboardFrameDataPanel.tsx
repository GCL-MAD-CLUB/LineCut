import { useState, type ComponentProps } from "react";
import { StoryboardSidebarHeading } from "../StoryboardSidebarSection";
import { StoryboardHistogramPanel } from "./StoryboardHistogramPanel";
import { StoryboardMotionPanel } from "./StoryboardMotionPanel";

interface Props extends ComponentProps<typeof StoryboardMotionPanel> {
  histogramVisible: boolean;
}

export function StoryboardFrameDataPanel({ histogramVisible, ...motionProps }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <section className="storyboard-frame-data-panel">
      <StoryboardSidebarHeading
        title="帧数据"
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />
      <div hidden={!open}>
        <StoryboardHistogramPanel visible={histogramVisible && open} />
        <StoryboardMotionPanel {...motionProps} visible={motionProps.visible && open} />
      </div>
    </section>
  );
}
