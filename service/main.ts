import { startDecisionUiServers } from './server.ts';

const running = await startDecisionUiServers({ env: process.env });

const shutdown = async () => {
  await running.close();
  process.exit(0);
};

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
