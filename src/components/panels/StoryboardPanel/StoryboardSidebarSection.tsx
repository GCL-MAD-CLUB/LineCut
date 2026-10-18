import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

interface SidebarHeadingProps {
  title: string;
  open: boolean;
  onToggle: () => void;
}

export function StoryboardSidebarHeading({ title, open, onToggle }: SidebarHeadingProps) {
  return (
    <header className={`storyboard-keyword-panel-heading ${open ? "" : "is-collapsed"}`.trim()}>
      <button
        type="button"
        className="storyboard-keyword-panel-heading-title"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
      </button>
    </header>
  );
}

interface SidebarSectionProps extends SidebarHeadingProps {
  control?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function StoryboardSidebarSection({
  title,
  control,
  open,
  className = "",
  onToggle,
  children,
}: SidebarSectionProps) {
  return (
    <section
      className={`storyboard-keyword-section ${className} ${open ? "" : "is-collapsed"}`.trim()}
    >
      <header
        className={`storyboard-keyword-section-header ${control ? "has-control" : ""}`.trim()}
      >
        <button
          type="button"
          className="storyboard-keyword-section-title"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span>{title}</span>
        </button>
        {control}
        <button
          type="button"
          className="storyboard-keyword-section-toggle"
          onClick={onToggle}
          aria-label={open ? `折叠${title}` : `展开${title}`}
          aria-expanded={open}
        >
          <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>
      {open && <div className="storyboard-keyword-section-body">{children}</div>}
    </section>
  );
}
