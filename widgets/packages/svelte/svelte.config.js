import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Used by svelte-package (build) and svelte-check (typecheck) to preprocess
// <script lang="ts"> in the .svelte components.
export default {
  preprocess: vitePreprocess(),
};
