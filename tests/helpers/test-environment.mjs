// Test fixtures can bind interactive/RPC sessions, but must never publish
// metadata to the real terminal from which `npm test` was launched.
delete process.env.HC_TERMINAL_ID;
