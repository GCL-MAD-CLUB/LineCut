# Windows `.lcp` thumbnail provider

Windows Explorer loads `linecut_thumbnail_provider.dll` as an in-process COM thumbnail provider.
It returns the same LineCut project-card artwork for every `.lcp` file, without opening or
decrypting the project. This keeps encrypted project data out of the Explorer process.

## Design asset

Place the approved card artwork at:

`src-tauri/thumbnail-provider/assets/lcp-thumbnail.png`

The build embeds that file in the provider DLL, so no separate artwork file is installed and it
cannot be changed after installation. If the file is absent, the provider builds a small generic
fallback card; a release must not use that fallback.

Use one PNG with these characteristics:

- 32-bit RGBA PNG, preferably 1280 x 720 pixels (16:9); 1920 x 1080 is also suitable.
- Design the whole canvas as the thumbnail card. Explorer preserves its aspect ratio and scales it
  down, so keep text and logos inside a roughly 8% safe margin.
- Use opaque backgrounds unless transparency is part of the design; a transparent PNG may be shown
  against the user's Explorer theme.
- Do not provide an ICO, PSD, SVG, or a set of size variants for this asset. The provider creates
  the required bitmap sizes from this one PNG.

## Build and registration

`npm run build:thumbnail-provider` builds the DLL. `tauri build` runs the same step before the
NSIS bundling phase, installs the DLL beside `LineCut.exe`, registers its CLSID and binds it to the
`LineCut.Project` file type. The installer also writes an empty `TypeOverlay` value so Explorer
does not add the application's default icon as a lower-right badge. The uninstaller removes the
binding and the DLL. Explorer receives a shell-association refresh after either operation.

The provider is currently built for the x64 Windows release produced by this repository. Explorer
can keep shell extensions loaded; after installing or uninstalling during development, close all
Explorer windows or restart Explorer before checking a changed DLL.
