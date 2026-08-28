<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  src: string;
  alt: string;
}>();

const failed = ref(false);
const resolvedSrc = computed(() => withBase(props.src));

watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <figure v-if="failed" class="guide-image-placeholder" role="img" :aria-label="alt">
    <strong>截图待补</strong>
    <figcaption>{{ alt }}</figcaption>
  </figure>
  <img
    v-else
    class="guide-image"
    :src="resolvedSrc"
    :alt="alt"
    loading="lazy"
    decoding="async"
    @error="failed = true"
  />
</template>
