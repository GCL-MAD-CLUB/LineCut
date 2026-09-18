import { invokeCommand, runOperation } from "../../errors";
import type { ImportSettings } from "./importBrowserModel";

export interface ImportBrowserConfig {
  favorites: string[];
  lastDirectory: string | null;
  settings: ImportSettings;
}

export const defaultImportSettings: ImportSettings = {
  newBin: false,
  binName: "媒体箱",
  copy: false,
  verify: true,
  destination: "project",
  customDirectory: "",
  autoBind: false,
  autoBindType: "all",
  autoBindPreset: "direct",
  autoBindPreference: "smart",
};

const emptyImportBrowserConfig: ImportBrowserConfig = {
  favorites: [],
  lastDirectory: null,
  settings: defaultImportSettings,
};

type ImportBrowserConfigPatch = Partial<ImportBrowserConfig>;

let configWrite = Promise.resolve();

function normalizeImportSettings(
  value: Partial<ImportSettings> | null | undefined,
): ImportSettings {
  return {
    ...defaultImportSettings,
    ...value,
    destination: value?.destination === "custom" ? "custom" : "project",
    autoBindType:
      value?.autoBindType === "audio" || value?.autoBindType === "subtitle"
        ? value.autoBindType
        : "all",
    autoBindPreset: value?.autoBindPreset === "virtual-copy" ? "virtual-copy" : "direct",
    autoBindPreference: value?.autoBindPreference === "name" ? "name" : "smart",
  };
}

export async function loadImportBrowserConfig() {
  await configWrite;
  const outcome = await runOperation("workspace.load", () =>
    invokeCommand<ImportBrowserConfig>("load_import_browser_config"),
  );
  if (outcome.status !== "success") return emptyImportBrowserConfig;
  return {
    favorites: outcome.value.favorites ?? [],
    lastDirectory: outcome.value.lastDirectory ?? null,
    settings: normalizeImportSettings(outcome.value.settings),
  };
}

function updateImportBrowserConfig(patch: ImportBrowserConfigPatch) {
  const snapshot = structuredClone(patch);
  const write = async () => {
    await runOperation("workspace.save", () =>
      invokeCommand("update_import_browser_config", { patch: snapshot }),
    );
  };
  configWrite = configWrite.then(write, write);
  return configWrite;
}

export function saveImportBrowserFavorites(favorites: string[]) {
  return updateImportBrowserConfig({ favorites: [...favorites] });
}

export function saveImportBrowserLastDirectory(directory: string) {
  return updateImportBrowserConfig({ lastDirectory: directory });
}

export function saveImportSettings(settings: ImportSettings) {
  return updateImportBrowserConfig({ settings });
}
