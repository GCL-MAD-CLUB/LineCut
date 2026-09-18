import { invokeCommand, runOperation } from "../../errors";

export interface ImportBrowserConfig {
  favorites: string[];
  lastDirectory: string | null;
}

const emptyImportBrowserConfig: ImportBrowserConfig = {
  favorites: [],
  lastDirectory: null,
};

let favoriteWrite = Promise.resolve();
let lastDirectoryWrite = Promise.resolve();

export async function loadImportBrowserConfig() {
  await Promise.all([favoriteWrite, lastDirectoryWrite]);
  const outcome = await runOperation("workspace.load", () =>
    invokeCommand<ImportBrowserConfig>("load_import_browser_config"),
  );
  return outcome.status === "success" ? outcome.value : emptyImportBrowserConfig;
}

export function saveImportBrowserFavorites(favorites: string[]) {
  const snapshot = [...favorites];
  favoriteWrite = favoriteWrite.then(async () => {
    await runOperation("workspace.save", () =>
      invokeCommand("save_import_browser_favorites", { favorites: snapshot }),
    );
  });
  return favoriteWrite;
}

export function saveImportBrowserLastDirectory(directory: string) {
  lastDirectoryWrite = lastDirectoryWrite.then(async () => {
    await runOperation("workspace.save", () =>
      invokeCommand("save_import_browser_last_directory", { directory }),
    );
  });
  return lastDirectoryWrite;
}
