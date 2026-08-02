#!/usr/bin/env node
import path from "node:path";

import { build } from "esbuild";

import { createBundleOptions, pluginDir } from "./bundle-config.mjs";

await build(createBundleOptions(path.join(pluginDir, "server.bundle.mjs")));
