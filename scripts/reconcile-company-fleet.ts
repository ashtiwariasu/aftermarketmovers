import { reconcileCompanyFleetFromDesks } from "../src/lib/companyFleet";
import { listAllDesks } from "../src/lib/desk";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const desks = await listAllDesks();
  const result = await reconcileCompanyFleetFromDesks(desks, startedAt);
  process.stdout.write(`${JSON.stringify({
    schema: "company-fleet-v1",
    desks: desks.length,
    activeCompanies: result.active.length,
    pausedCompanies: result.paused.length,
    membershipsAdded: result.membershipsAdded,
    membershipsRemoved: result.membershipsRemoved,
    active: result.active,
    elapsedMs: Date.now() - startedAt,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
