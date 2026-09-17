import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Film,
  HardDrive,
  House,
  Image,
  Monitor,
  Music,
} from "lucide-react";
import { useState } from "react";
import { pathKey, type ImportLocation } from "./importBrowserModel";

const icons = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  videos: Film,
  music: Music,
  pictures: Image,
  device: HardDrive,
};
export function ImportSidebar({
  locations,
  directory,
  onNavigate,
}: {
  locations: ImportLocation[];
  directory: string;
  onNavigate: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  return (
    <aside className="import-sidebar" aria-label="导入位置">
      {[
        ["local", "本地"],
        ["device", "设备"],
      ].map(([group, label]) => (
        <section key={group}>
          <button
            className="import-sidebar-heading"
            aria-expanded={!collapsed.has(group)}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                return next;
              })
            }
          >
            {collapsed.has(group) ? <ChevronRight /> : <ChevronDown />} {label}
          </button>
          {!collapsed.has(group) &&
            locations
              .filter((location) => (location.kind === "device") === (group === "device"))
              .map((location) => {
                const Icon = icons[location.kind as keyof typeof icons] ?? HardDrive;
                return (
                  <button
                    key={location.path + location.kind}
                    className={`import-location ${pathKey(directory) === pathKey(location.path) ? "active" : ""}`}
                    title={location.path}
                    onClick={() => onNavigate(location.path)}
                  >
                    <Icon />
                    <span>{location.name}</span>
                  </button>
                );
              })}
        </section>
      ))}
    </aside>
  );
}
