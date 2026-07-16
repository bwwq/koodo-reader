import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "gs.ouo.rd.koodo",
  appName: "Koodo Reader",
  webDir: "build",
  server: {
    androidScheme: "https",
  },
};

export default config;
