import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the Worker (worker/index.ts) inside the real
// Workers runtime during `npm run dev`, so local behaviour matches production.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
