import { port } from "./config.js";
import { createDatabase } from "./db/client.js";
import { buildServer } from "./api/server.js";
import { manifests } from "./platform/manifests.js";

const db = createDatabase();
const app = buildServer({ db, manifests });

// Bound to the loopback interface: the built-in check makes knowing a tenant id
// enough to act as that tenant, and that must not be reachable from a network.
await app.listen({ port, host: "127.0.0.1" });
