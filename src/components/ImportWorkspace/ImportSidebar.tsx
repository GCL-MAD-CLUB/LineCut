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
  Star,
} from "lucide-react";
import { useState } from "react";
import { breadcrumbs, pathKey, type ImportLocation } from "./importBrowserModel";

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
  favorites,
  directory,
  onNavigate,
}: {
  locations: ImportLocation[];
  favorites: string[];
  directory: string;
  onNavigate: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const groups = [
    {
      id: "favorites",
      label: "收藏夹",
      locations: favorites.map((path) => ({
        path,
        name: breadcrumbs(path).at(-1)?.name ?? path,
        kind: "favorite",
      })),
    },
    {
      id: "local",
      label: "本地",
      locations: locations.filter((location) => location.kind !== "device"),
    },
    {
      id: "device",
      label: "设备",
      locations: locations.filter((location) => location.kind === "device"),
    },
  ];
  return (
    <aside className="import-sidebar" aria-label="导入位置">
      {groups.map((group) => (
        <section key={group.id}>
          <button
            className="import-sidebar-heading"
            aria-expanded={!collapsed.has(group.id)}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                return next;
              })
            }
          >
            {collapsed.has(group.id) ? <ChevronRight /> : <ChevronDown />} {group.label}
          </button>
          {!collapsed.has(group.id) &&
            group.locations.map((location) => {
              const favorite = location.kind === "favorite";
              const Icon = favorite
                ? Star
                : (icons[location.kind as keyof typeof icons] ?? HardDrive);
              return (
                <button
                  key={location.path + location.kind}
                  className={`import-location ${favorite ? "is-favorite" : ""} ${pathKey(directory) === pathKey(location.path) ? "active" : ""}`}
                  title={location.path}
                  onClick={() => onNavigate(location.path)}
                >
                  <Icon fill={favorite ? "currentColor" : "none"} />
                  <span>{location.name}</span>
                </button>
              );
            })}
        </section>
      ))}
    </aside>
  );
}
