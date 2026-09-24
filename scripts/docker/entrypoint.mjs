// Starts the Next.js standalone server for whichever app this image was built for. The demo first creates
// its own application and API key in OTPlease (see demo-entrypoint.mjs).
import { spawn } from "node:child_process";

const app = process.env.APP ?? "web";
if (app === "demo") await (await import("./demo-entrypoint.mjs")).bootstrap();

const child = spawn("node", [`apps/${app}/server.js`], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
