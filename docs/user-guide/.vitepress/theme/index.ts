import DefaultTheme from "vitepress/theme";
import { withBase } from "vitepress";
import { h } from "vue";
import "./custom.css";

const GuideImage = {
  props: {
    src: { type: String, required: true },
    alt: { type: String, required: true },
  },
  setup(props: { src: string; alt: string }) {
    return () =>
      h("img", {
        class: "guide-image",
        src: withBase(props.src),
        alt: props.alt,
        loading: "lazy",
      });
  },
};

export default {
  extends: DefaultTheme,
  enhanceApp({
    app,
  }: {
    app: { component: (name: string, component: typeof GuideImage) => void };
  }) {
    app.component("GuideImage", GuideImage);
  },
};
