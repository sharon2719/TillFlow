import { app } from "./app.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info({ port }, "pos service listening");
});
