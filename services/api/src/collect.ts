// Runs the collector on its own, so the trial record survives API restarts.
import { join, resolve } from "node:path";
import { Collector, loadSchedule, openMeasurements } from "./collector.ts";

const root = resolve(import.meta.dirname, "../../..");
const dataDir = resolve(process.env.DATA_DIR ?? join(root, "data"));
const routes = (process.env.ARCHIVE_ROUTES ?? "52,11,75,82").split(",").filter(Boolean);

const collector = new Collector(openMeasurements(join(dataDir, "measurements.db")), loadSchedule(join(import.meta.dirname, "../assets/departures.json.gz")), {
  archive: { dir: join(dataDir, "rt"), routes },
});
collector.start();
console.log(`Collecting live vehicles into ${dataDir}, archiving routes ${routes.join(", ")}`);

const stop = () => {
  collector.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
