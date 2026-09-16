import { app } from "./app.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3003);

app.listen(port, () => {
  logger.info({ port }, "web service listening");
});
