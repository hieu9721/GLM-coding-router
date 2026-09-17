import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

export const version: string = require("../../package.json").version as PackageJson["version"];
