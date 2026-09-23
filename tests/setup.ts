import { flushTestRedis } from "./helpers";

// Runs before each test file is imported. Files that build workers at import time
// would otherwise pick up jobs left in Redis by the previous file.
await flushTestRedis();
