import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import GuideImage from "./GuideImage.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("GuideImage", GuideImage);
  },
} satisfies Theme;
