import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  base: "./",
  server: { port: 5174, strictPort: true },
  build: { target: "es2022" },
});
