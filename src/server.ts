import { pool } from './db/client';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3001);
const app = createApp(pool);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`listening on ${port}`);
});

