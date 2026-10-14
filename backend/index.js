import { app } from './server.js';
import { env } from './config/env.js';

const server = app.listen(env.port, () => {
  console.log(`API server: http://localhost:${env.port}/api`);
});

server.on('error', (error) => {
  console.error(`伺服器啟動失敗：${error.code || 'UNKNOWN'}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
