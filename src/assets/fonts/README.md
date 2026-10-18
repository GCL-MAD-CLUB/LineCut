# Bundled UI font

`locution-pro-ui-sans-vf.woff2` comes from face 2 (Source Han Sans SC VF) of
`SourceHanSans-VF.ttf.ttc`, version 2.005. It is converted with FontTools to WOFF2
without subsetting or changing outlines. The variable `wght` axis spans 250–900.

The font family and PostScript names are renamed to Locution Pro UI Sans / LocutionProUISans
to respect the reserved font name. Original copyright and licensing metadata are
retained. See [OFL.txt](OFL.txt) for the SIL Open Font License 1.1.

Source collection SHA-256:
`6b23fac4bcecf95745f7266974549a84a58827032483dd1ccd52096710763fe0`.

The frontend loads the font through `src/styles.css`; Vite includes it in the
frontend build, which Tauri embeds in the application. The installer also includes
the license as `licenses/locution-pro-ui-sans-OFL.txt`.
